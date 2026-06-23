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

Extend `#enqueueStandard`:

- Add field `#dedupIndex: Map<string, string>` — dedupKey → entry key in `#globalOrder`/`#pending`.
- Add field `#deduped = 0` and `get deduped(): number`.
- Before the monotonic-key push: if `isDedupEligible(req.kind)`, compute `dedupKey(req)`.
  - **Found in `#dedupIndex`** → coalesce in place (mirror the existing loop coalesce path in `#enqueueLoop`): mutate the existing entry — replace `req`, recompute `byteSize` delta (`this.byteSize += byteSize - prevBytes`), set `coalesced = true`, bump `coalescedTickCount` (`(existing.coalescedTickCount ?? 1) + 1`). Do **not** touch `#globalOrder` position (preserves delivery order). Bump `#deduped`, emit `monitorDebug('idleQueue.dedup', { sessionID, jobID, kind, coalescedTickCount })`. Return early — before `#applyCaps`, so coalescing never interacts with eviction/caps.
  - **Not found** → normal monotonic-key push, then register dedupKey → entry key in `#dedupIndex`.
- **Every removal path** deletes the entry's dedupKey from `#dedupIndex`: `#shiftAndDeliver`, the targeted-flush branch in `flush(sessionID)`, `#evictFifo`, `#evictOldestForJob`. This is the critical correctness invariant — once delivered/evicted, a later identical message is a new event and must not be suppressed.
- Generalize the delivery annotation in `#requestForDelivery`: `[coalesced N ticks while session was busy]` (drop "loop") so it reads correctly for all kinds. Existing tests asserting `coalesced 3 loop ticks` (in `test/idle-queue.test.ts:229`, `test/integration.test.ts:128`) must be updated.

`#enqueueLoop` is unchanged — loop keeps its own `${sessionID}::${jobID}` coalesce key and is not routed through the new dedup path.

### `DeliveryQueue` (`src/delivery/delivery-queue.ts`)

Drop-on-duplicate in `enqueue` (no annotation path exists here — HTTP flush sends raw reqs):

- Add field `#dedupKeys: Set<string>` and `#deduped = 0`; `get deduped(): number`.
- In `enqueue`, after `#pruneExpired`: if `isDedupEligible(req.kind)` and `#dedupKeys.has(dedupKey(req))` → bump `#deduped` (and `dropped`, since drop is the semantically correct "dropped" event for this queue), emit `monitorDebug('deliveryQueue.dedup', { sessionID, jobID, kind })`, return without pushing.
- Otherwise push and `#dedupKeys.add(dedupKey(req))`.
- `#pruneExpired`: when an entry expires, also delete its dedupKey from `#dedupKeys`.
- `drain` and `flush`: clear `#dedupKeys` (delivered/flushed means a future identical message is new — same invariant as `IdleQueue`).

## Data Flow

### Session-busy path (monitor fires 3× with identical output)

1. `bridge.notify(req₁)` → `IdleQueue.deliver(req₁)` → session `busy` → `enqueue(req₁)`.
2. `#enqueueStandard`: `mon` eligible, dedupKey absent → monotonic push + register dedupKey. `pendingCount === 1`, `deduped === 0`.
3. `bridge.notify(req₂)` (identical) → dedupKey hit → coalesce in place: `req` replaced, `coalescedTickCount = 2`, `deduped = 1`. `pendingCount === 1`, order unchanged.
4. `bridge.notify(req₃)` (identical) → `coalescedTickCount = 3`, `deduped = 2`. `pendingCount === 1`.
5. `setSessionStatus('idle', sessionID)` → `flush(sessionID)` → `#shiftAndDeliver` → `#requestForDelivery` emits text `"<window>\n\n[coalesced 3 ticks while session was busy]"`. Entry removed → dedupKey deleted from `#dedupIndex`.
6. Monitor fires again 20s later with identical output → dedupKey gone → fresh entry. Correct (new event).

### Bridge-down path

`appendSubmitToSession` throws → caller falls back to `DeliveryQueue.enqueue`. Identical payloads: first push + register key; subsequent drops, `dropped`/`deduped` bumped. On bridge recovery, `drain()`/`flush()` delivers survivors and clears `#dedupKeys`. No annotation — by design.

### Order & isolation

- **Order preserved:** a coalesced entry keeps its original `#globalOrder` index. Mixed queue `[bg₁, mon₁, sched₁]` with `mon₁` coalescing 3× still flushes in order `bg₁, mon₁(coalesced), sched₁`.
- **Distinct payloads don't collide:** monitor windows with same matched lines but different `matchSeqs` produce different `text` (formatter includes seq context) → different sha1 → different dedupKey → both queue.
- **Cross-kind isolation:** dedupKey includes `kind`.
- **Cross-session isolation:** dedupKey includes `sessionID`.
- **Cap interaction:** coalesce returns before `#applyCaps`/per-job cap, so no eviction is triggered to make room for a duplicate.

## Error Handling & Edge Cases

- `dedup.ts` is pure; `sha1` over any input cannot throw in a way that matters. Empty-string payloads hash deterministically — two empty `mon` windows coalesce (acceptable; empty monitor output is noise worth deduping).
- Coalesce path returns early before `#applyCaps`, so it never interacts with eviction — no new deadlock surface.
- **Removal clears dedup state** (critical invariant): every removal path deletes the dedupKey. Without this a delivered entry would suppress its own legitimate re-fire.
- **Eviction of the coalesced head:** if caps evict the entry holding a dedupKey, the key goes with it; next identical enqueue is fresh.
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

- Enqueue 3 identical `mon` while busy → `pendingCount === 1`, `coalescedTickCount === 3`, `deduped === 2`. Delivered text contains `[coalesced 3 ticks while session was busy]`.
- Enqueue 2 identical `bg` + 1 distinct `bg` for same job → `pendingCount === 2`, order preserved.
- Enqueue identical `mon`, flush, enqueue identical `mon` again → second is fresh (`coalescedTickCount === 1`). **Critical invariant test.**
- Distinct payloads (different seq context) → both queue, `pendingCount === 2`.
- Cross-kind: identical `mon` and `loop` for same `jobID` → 2 entries.
- Cross-session: identical payloads, different `sessionID` → 2 entries.
- Coalesced entry evicted by per-job cap → dedupKey gone; next identical enqueue is fresh.
- `loop` behavior unchanged — existing tests still pass (regression guard). Update the two assertions on literal `coalesced 3 loop ticks` → `coalesced 3 ticks`.

### `test/delivery-queue.test.ts` (extend)

- Enqueue 3 identical `mon` while bridge down → `length === 1`, `dropped === 2`. `drain()` → 1 req; `drain()` again → 0.
- After `drain`/`flush`, identical enqueue accepted again.
- Expired entry's dedupKey also cleared (enqueue identical after TTL expiry accepted).
- Distinct payloads queue separately; cross-kind no collision.

### `test/integration.test.ts` (extend, light)

One end-to-end: busy session, monitor fires 3× identical, session goes idle, assert exactly one delivered `AutoSubmitRequest` with coalesced annotation reaches `onDelivery`/`onAppend`. Update the existing assertion at line 128 from `coalesced 3 loop ticks` → `coalesced 3 ticks`.

### Regression

Existing `idle-queue`, `delivery-queue`, loop coalescing, and `integration` tests must pass unchanged (aside from the two intentional string-assertion updates).