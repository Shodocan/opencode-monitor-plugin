# Queue Dedup Design

**Date:** 2026-06-22
**Status:** Approved (brainstorm)
**Topic:** Deduplicate identical messages queued while a session is busy (or the bridge is down), to keep the session context clean.

## Problem

While a session is `busy`/`retry`, incoming `AutoSubmitRequest`s are held in `IdleQueue` (`src/bridge/idle-queue.ts`) until the session goes idle. Identical requests — e.g. a monitor whose regex match output is unchanged across consecutive fires — are currently enqueued as separate entries (standard kinds use a monotonic key `${sessionID}::${jobID}::${nextEntryID}`, never deduped). When the session finally goes idle, all copies flush into the session context, dirtying it with repeated content.

The bridge-down `DeliveryQueue` (`src/delivery/delivery-queue.ts`) has the same flaw: pure FIFO array, no dedup, so identical payloads pile up while the bridge is unavailable.

`/loop` already coalesces: same `${sessionID}::${jobID}` key → latest replaces prior, `coalescedTickCount` bumped, delivery annotated `[coalesced N loop ticks while session was busy]`. This design extends that coalescing semantics to the remaining kinds.

## Decisions (locked during brainstorm)

1. **Mode:** Coalesce + count. Identical payloads merge into one pending entry with a repeat count visible to the model. Matches existing `/loop` behavior.
2. **Eligible kinds:** `mon`, `bg`, `sched` (all non-loop kinds). `loop` retains its existing coalesce path unchanged.
3. **Scope:** Both queues — `IdleQueue` (session busy) and `DeliveryQueue` (bridge down) — share one dedup-key helper.
4. **Identity key:** `${sessionID}::${jobID}::${kind}::${sha1(text)}`. `kind` included so a `mon` entry can never collide with a `loop` entry for the same job. `agent` intentionally excluded (same job → same session).
5. **Observability:** `deduped` counter getter on each queue + `monitorDebug` lines mirroring the existing `dropped` counter and debug logging. Not surfaced in the TUI status store yet (deferred).

## Architecture

### `src/delivery/dedup.ts` (new, ~25 lines)

Pure helper, no state. Exported:

- `hashText(text: string): string` — `crypto.createHash('sha1').update(text).digest('hex')`. Non-security use; collisions irrelevant at payload scale (≤16 KB monitor / ≤32 KB bg output). `sha1` already available via `node:crypto` used elsewhere in the codebase.
- `dedupKey(req: AutoSubmitRequest): string` — `${req.sessionID}::${req.jobID}::${req.kind}::${hashText(req.text)}`.
- `isDedupEligible(kind: JobKind): boolean` — `kind !== 'loop'`. Centralizes the eligibility policy so both queues agree.

### `IdleQueue` (`src/bridge/idle-queue.ts`)

Extend `#enqueueStandard`. **Dedup coalescing uses its own fields, NOT the existing `coalesced`/`coalescedTickCount` fields** — those belong to the `/loop` path and are protected from FIFO eviction (`#evictFifo` predicate `!entry.coalesced`, line 327). Reusing them for content-dedup would make mon/bg/sched entries un-evictable by `#evictFifo`, silently breaking the global/byte caps (see Eviction interaction below). Keeping the two concepts separate isolates the new feature from the loop path entirely.

- Extend `IdlePendingEntry` with two optional fields:
  - `dedupKey?: string` — stored on the entry so removal can clear the index without a reverse lookup.
  - `dedupCount?: number` — repeat count for this content (defaults to 1 / absent).
- Add field `#dedupIndex: Map<string, string>` — dedupKey → entry key in `#globalOrder`/`#pending`.
- Add field `#deduped = 0` and `get deduped(): number`.
- In `#enqueueStandard`, before the monotonic-key push: if `isDedupEligible(req.kind)`, compute `dedupKey(req)`.
  - **Found in `#dedupIndex`** → coalesce in place: mutate the existing entry — replace `req`, recompute `byteSize` delta (`this.byteSize += byteSize - prevBytes`), bump `dedupCount` (`(existing.dedupCount ?? 1) + 1`). Do **not** set `coalesced`/`coalescedTickCount` and do **not** touch `#globalOrder` position (preserves delivery order). Bump `#deduped`, emit `monitorDebug('idleQueue.dedup', { sessionID, jobID, kind, dedupCount })`. Return early — before `#applyCaps`, so dedup never interacts with eviction/caps.
  - **Not found** → normal monotonic-key push, set `entry.dedupKey = key` and `entry.dedupCount = 1`, then register dedupKey → entry key in `#dedupIndex`.
- **Every removal path** deletes the entry's `dedupKey` from `#dedupIndex` (if present): `#shiftAndDeliver`, the targeted-flush branch in `flush(sessionID)`, `#evictFifo`, `#evictOldestForJob`. This is the critical correctness invariant — once delivered/evicted, a later identical message is a new event and must not be suppressed. Use the entry's stored `dedupKey` field to look up the index key (no reverse scan needed); skip if the entry has no `dedupKey` (loop entries, or standard entries that never deduped).
- `#requestForDelivery`: extend the existing check. If `entry.dedupCount` and `entry.dedupCount > 1` → annotate text `[deduped N identical messages while session was busy]` (distinct wording from the loop annotation so the model can tell the two coalescing reasons apart). The existing loop branch (`entry.coalesced`/`coalescedTickCount`) is untouched and keeps its `[coalesced N loop ticks while session was busy]` wording. **No existing string changes** — no test-assertion updates needed for loop.
- `#countJobEntries` (line 312): dedup entries are counted like any standard entry (no guard), so the per-job cap (`#evictOldestForJob`) correctly counts and can evict them — `#evictOldestForJob` has no `!coalesced` guard, so it already handles them.

`#enqueueLoop` is unchanged — loop keeps its own `${sessionID}::${jobID}` coalesce key, the `coalesced`/`coalescedTickCount` fields, and the `#evictFifo` protection. Not routed through the new dedup path.

#### Eviction interaction (why separate fields)

`#evictFifo` (line 324-339) skips `coalesced` entries by design — the live loop entry must not be discarded mid-coalesce. If dedup reused `coalesced: true`, deduped mon/bg/sched entries would inherit that protection and `#applyCaps`'s `while (pendingCount >= MAX_PENDING_GLOBAL)` / `while (byteSize >= MAX_QUEUE_BYTES_TOTAL)` loops would find nothing to evict, silently unenforcing the caps → unbounded memory growth while a session stays busy long enough. By using a separate `dedupKey`/`dedupCount` and **not** setting `coalesced`, dedup entries remain fully evictable by `#evictFifo` (same as any standard entry), and loop's eviction protection is untouched.

### `DeliveryQueue` (`src/delivery/delivery-queue.ts`)

Drop-on-duplicate in `enqueue` (no annotation path exists here — HTTP flush sends raw reqs):

- Add field `#dedupKeys: Set<string>` and `#deduped = 0`; `get deduped(): number`.
- In `enqueue`, after `#pruneExpired`: if `isDedupEligible(req.kind)` and `#dedupKeys.has(dedupKey(req))` → bump both `#deduped` and `dropped` (a dedup-drop is semantically a drop, so it counts in the existing `dropped` total), emit `monitorDebug('deliveryQueue.dedup', { sessionID, jobID, kind })`, return without pushing. No existing `delivery-queue` test enqueues identical reqs (the `req()` helper produces distinct jobIDs/text per call), so no existing `dropped` assertion changes.
- Otherwise push and `#dedupKeys.add(dedupKey(req))`.
- `#pruneExpired`: when an entry expires, also delete its dedupKey from `#dedupKeys`.
- `drain` and `flush`: clear `#dedupKeys` (delivered/flushed means a future identical message is new — same invariant as `IdleQueue`).

## Data Flow

### Session-busy path (monitor fires 3× with identical output)

1. `bridge.notify(req₁)` → `IdleQueue.deliver(req₁)` → session `busy` → `enqueue(req₁)`.
2. `#enqueueStandard`: `mon` eligible, dedupKey absent → monotonic push + register dedupKey. `pendingCount === 1`, `deduped === 0`.
3. `bridge.notify(req₂)` (identical) → dedupKey hit → coalesce in place: `req` replaced, `dedupCount = 2`, `deduped = 1`. `pendingCount === 1`, order unchanged. `coalesced` stays unset (entry remains evictable).
4. `bridge.notify(req₃)` (identical) → `dedupCount = 3`, `deduped = 2`. `pendingCount === 1`.
5. `setSessionStatus('idle', sessionID)` → `flush(sessionID)` → `#shiftAndDeliver` → `#requestForDelivery` emits text `"<window>\n\n[deduped 3 identical messages while session was busy]"`. Entry removed → dedupKey deleted from `#dedupIndex`.
6. Monitor fires again 20s later with identical output → dedupKey gone → fresh entry. Correct (new event).

### Bridge-down path

`appendSubmitToSession` throws → caller falls back to `DeliveryQueue.enqueue`. Identical payloads: first push + register key; subsequent drops, `dropped`/`deduped` bumped. On bridge recovery, `drain()`/`flush()` delivers survivors and clears `#dedupKeys`. No annotation — by design.

### Order & isolation

- **Order preserved:** a deduped entry keeps its original `#globalOrder` index. Mixed queue `[bg₁, mon₁, sched₁]` with `mon₁` deduped 3× still flushes in order `bg₁, mon₁(deduped), sched₁`.
- **Distinct payloads don't collide:** monitor windows with same matched lines but different `matchSeqs` produce different `text` (formatter includes seq context) → different sha1 → different dedupKey → both queue.
- **Cross-kind isolation:** dedupKey includes `kind`.
- **Cross-session isolation:** dedupKey includes `sessionID`.
- **Cap interaction:** dedup returns before `#applyCaps`/per-job cap, so no eviction is triggered to make room for a duplicate. And because dedup entries are **not** marked `coalesced`, they remain evictable by `#evictFifo` like any standard entry when genuinely-new entries push the queue over the global/byte cap.

## Error Handling & Edge Cases

- `dedup.ts` is pure; `sha1` over any input cannot throw in a way that matters. Empty-string payloads hash deterministically — two empty `mon` windows dedup (acceptable; empty monitor output is noise worth deduping).
- Dedup path returns early before `#applyCaps`, so it never interacts with eviction — no new deadlock surface. Dedup entries are evictable by `#evictFifo` (they are not `coalesced`), so caps remain enforced even when all pending entries are deduped.
- **Removal clears dedup state** (critical invariant): every removal path deletes the dedupKey. Without this a delivered entry would suppress its own legitimate re-fire.
- **Eviction of the deduped head:** if caps evict the entry holding a dedupKey, the key goes with it; next identical enqueue is fresh.
- **`agent` excluded from key** — same job targets same session; agent change mid-flight is config change, not duplicate content. Matches existing loop behavior.
- **`DeliveryQueue` drop semantics:** no coalesce-annotation path (HTTP flush sends raw reqs). Duplicate → keep first, drop rest, bump `dropped`+`deduped`. Documented limitation; acceptable given bridge-down is rare and short-lived (10-min TTL).
- **Hashing cost:** sha1 per enqueue, payloads ≤16–32 KB. Negligible vs the HTTP roundtrip that follows. No throttling.
- **No persistent "recently sent" cache:** dedup is strictly within the pending queue. Once drained/flushed, memory clears. Suppressing legitimate later repeats is debounce — a separate feature, out of scope.

## Rollback

Purely additive. `IdleQueue` gains `#dedupIndex` + `#deduped`; `DeliveryQueue` gains `#dedupKeys` + `#deduped`; one new pure module. Reverting the three files returns to current behavior exactly — no schema, migration, or persisted-state change.

## Testing

### `test/dedup.test.ts` (new)

- `dedupKey` equal for identical reqs; differs when `sessionID`, `jobID`, `kind`, or `text` changes individually.
- `hashText` deterministic and stable.
- `isDedupEligible('loop') === false`; `true` for `bg`/`mon`/`sched`.

### `test/idle-queue.test.ts` (extend)

- Enqueue 3 identical `mon` while busy → `pendingCount === 1`, `dedupCount === 3`, `deduped === 2`, entry's `coalesced` is **unset** (remains evictable). Delivered text contains `[deduped 3 identical messages while session was busy]`.
- Enqueue 2 identical `bg` + 1 distinct `bg` for same job → `pendingCount === 2`, order preserved.
- Enqueue identical `mon`, flush, enqueue identical `mon` again → second is fresh (`dedupCount === 1`). **Critical invariant test.**
- Distinct payloads (different seq context) → both queue, `pendingCount === 2`.
- Cross-kind: identical `mon` and `loop` for same `jobID` → 2 entries, the `mon` one is deduped and the `loop` one is coalesced (distinct fields/wording).
- Cross-session: identical payloads, different `sessionID` → 2 entries.
- **Eviction correctness (the bug the review caught):** fill the queue to the global/byte cap with deduped `mon` entries, then enqueue one more → `#evictFifo` must evict a deduped entry (since they are not `coalesced`), clearing its dedupKey; `pendingCount` must not exceed `MAX_PENDING_GLOBAL` and `byteSize` must not exceed `MAX_QUEUE_BYTES_TOTAL`. Assert the cap is enforced.
- Deduped entry evicted by per-job cap → dedupKey gone; next identical enqueue is fresh.
- `loop` behavior unchanged — existing tests (including the two asserting literal `coalesced 3 loop ticks` at lines 229 and the integration test at line 128) still pass **unmodified**.

### `test/delivery-queue.test.ts` (extend)

- Enqueue 3 identical `mon` while bridge down → `length === 1`, `dropped === 2`. `drain()` → 1 req; `drain()` again → 0.
- After `drain`/`flush`, identical enqueue accepted again.
- Expired entry's dedupKey also cleared (enqueue identical after TTL expiry accepted).
- Distinct payloads queue separately; cross-kind no collision.

### `test/integration.test.ts` (extend, light)

One end-to-end: busy session, monitor fires 3× identical, session goes idle, assert exactly one delivered `AutoSubmitRequest` with the `[deduped 3 identical messages while session was busy]` annotation reaches `onDelivery`/`onAppend`. The existing `coalesced 3 loop ticks` assertion at line 128 covers the loop path and stays unchanged.

### Regression

Existing `idle-queue`, `delivery-queue`, loop coalescing, and `integration` tests must pass **unmodified** — the new feature uses separate fields and separate annotation wording, so no existing string assertions change.