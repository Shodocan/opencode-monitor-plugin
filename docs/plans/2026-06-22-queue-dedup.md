# Queue Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deduplicate identical messages that queue while a session is busy (or the bridge is down), coalescing repeats into one pending entry with a count, so the session context stays clean.

**Architecture:** A new pure helper `src/delivery/dedup.ts` defines the dedup identity key (`sessionID::jobID::kind::sha1(text)`) and eligibility policy (`kind !== 'loop'`). `IdleQueue` coalesces eligible standard entries in place using *separate* `dedupKey`/`dedupCount` fields (not the loop path's `coalesced`/`coalescedTickCount`, which are protected from FIFO eviction). `DeliveryQueue` drops identical payloads on enqueue. Every removal path clears dedup state so a later identical message is a fresh event.

**Tech Stack:** TypeScript, Vitest, `node:crypto` (sha1).

**Spec:** `docs/specs/2026-06-22-queue-dedup-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/delivery/dedup.ts` | Pure helpers: `hashText`, `dedupKey`, `isDedupEligible`. No state. | Create |
| `test/dedup.test.ts` | Unit tests for the three helpers. | Create |
| `src/bridge/idle-queue.ts` | Session-busy queue. Add dedup coalescing to `#enqueueStandard`, `#dedupIndex`, `deduped` counter, clear dedupKey in every removal path, `#requestForDelivery` annotation. | Modify |
| `test/idle-queue.test.ts` | Extend with dedup behavior + eviction-correctness tests. | Modify |
| `src/delivery/delivery-queue.ts` | Bridge-down queue. Drop-on-duplicate in `enqueue`, `#dedupKeys`, `deduped` counter, clear keys in TTL/drain/flush. | Modify |
| `test/delivery-queue.test.ts` | Extend with dedup behavior tests. | Modify |
| `test/integration.test.ts` | One end-to-end dedup test through the bridge. | Modify |

**Key invariant:** dedup entries are **never** marked `coalesced`, so they remain evictable by `#evictFifo` (which skips `coalesced` entries). This is the bug the spec review caught — do not conflate the two fields.

**Parallelism:** Task 1 (dedup.ts + tests) is the foundation — Tasks 3, 4, 6 import from it. Task 2 (IdleQueue) and Task 5 (DeliveryQueue) both depend on Task 1 but are independent of each other (disjoint files) → parallelizable after Task 1. Task 4 extends the IdleQueue test file (depends on Task 2). Task 7 (integration) depends on Tasks 2 + 5.

---

### Task 1: Pure dedup helper + tests

**Parallel:** no (foundation)
**Touches:** `src/delivery/dedup.ts`, `test/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dedup.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { AutoSubmitRequest } from '../src/types.js';
import { dedupKey, hashText, isDedupEligible } from '../src/delivery/dedup.js';

function req(
  sessionID = 's1',
  jobID = 'bg_1',
  kind: AutoSubmitRequest['kind'] = 'bg',
  text = 'hello',
): AutoSubmitRequest {
  return { sessionID, jobID, kind, text, submit: true };
}

describe('hashText', () => {
  it('is deterministic for the same input', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
  });
  it('differs for different input', () => {
    expect(hashText('hello')).not.toBe(hashText('world'));
  });
  it('is stable for empty string', () => {
    expect(hashText('')).toBe(hashText(''));
  });
});

describe('dedupKey', () => {
  it('is equal for identical requests', () => {
    expect(dedupKey(req())).toBe(dedupKey(req()));
  });
  it('differs when sessionID changes', () => {
    expect(dedupKey(req('s1'))).not.toBe(dedupKey(req('s2')));
  });
  it('differs when jobID changes', () => {
    expect(dedupKey(req('s1', 'bg_1'))).not.toBe(dedupKey(req('s1', 'bg_2')));
  });
  it('differs when kind changes', () => {
    expect(dedupKey(req('s1', 'bg_1', 'mon'))).not.toBe(dedupKey(req('s1', 'bg_1', 'bg')));
  });
  it('differs when text changes', () => {
    expect(dedupKey(req('s1', 'bg_1', 'bg', 'a'))).not.toBe(dedupKey(req('s1', 'bg_1', 'bg', 'b')));
  });
});

describe('isDedupEligible', () => {
  it('returns false for loop', () => {
    expect(isDedupEligible('loop')).toBe(false);
  });
  it('returns true for bg', () => {
    expect(isDedupEligible('bg')).toBe(true);
  });
  it('returns true for mon', () => {
    expect(isDedupEligible('mon')).toBe(true);
  });
  it('returns true for sched', () => {
    expect(isDedupEligible('sched')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dedup.test.ts`
Expected: FAIL — `Cannot find module '../src/delivery/dedup.js'` (or TS resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `src/delivery/dedup.ts`:

```typescript
import crypto from 'node:crypto';
import type { AutoSubmitRequest, JobKind } from '../types.js';

/**
 * SHA-1 hash of `text`. Non-security use — collisions are irrelevant at
 * payload scale (≤16 KB monitor / ≤32 KB bg output). Used only as a
 * dedup identity component.
 */
export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * Identity key for content dedup. Includes `kind` so a `mon` entry can
 * never collide with a `loop` entry for the same job. `agent` is
 * intentionally excluded (same job → same session).
 */
export function dedupKey(req: AutoSubmitRequest): string {
  return `${req.sessionID}::${req.jobID}::${req.kind}::${hashText(req.text)}`;
}

/**
 * Eligibility policy shared by both queues. `/loop` has its own existing
 * coalesce path and is excluded; all other kinds are dedup-eligible.
 */
export function isDedupEligible(kind: JobKind): boolean {
  return kind !== 'loop';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/dedup.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/delivery/dedup.ts test/dedup.test.ts
git commit -m "feat(dedup): add pure dedup-key helper"
```

---

### Task 2: IdleQueue — dedup coalescing in `#enqueueStandard`

**Parallel:** after Task 1
**Touches:** `src/bridge/idle-queue.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/idle-queue.test.ts` (new describe block at end of file):

```typescript
// ----------------------------------------------------------------
// IdleQueue — content dedup (mon/bg/sched)
// ----------------------------------------------------------------

describe('IdleQueue content dedup', () => {
  it('coalesces 3 identical mon entries into one with dedupCount', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    expect(q.pendingCount).toBe(1);
    expect(q.deduped).toBe(2);
    const entry = q.peek()[0];
    expect(entry.dedupCount).toBe(3);
    // Must NOT be marked coalesced — keeps it evictable by #evictFifo
    expect(entry.coalesced).toBeUndefined();
  });

  it('annotates delivery with dedup count', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.setSessionStatus('idle');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('window');
    expect(delivered[0].text).toContain('[deduped 3 identical messages while session was busy]');
  });

  it('keeps distinct payloads as separate entries', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'mon_1', 'mon', 'a'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'b'));
    expect(q.pendingCount).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('treats re-fired identical payload after flush as a fresh event', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.setSessionStatus('idle');
    expect(delivered).toHaveLength(1);
    // Session goes busy again; same payload must enqueue fresh, not be suppressed
    q.setSessionStatus('busy');
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    expect(q.pendingCount).toBe(1);
    const entry = q.peek()[0];
    expect(entry.dedupCount).toBe(1);
  });

  it('coalesces bg and sched kinds too', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_1', 'bg', 'out'));
    q.enqueue(req('s1', 'bg_1', 'bg', 'out'));
    q.enqueue(req('s1', 'sched_1', 'sched', 'run'));
    q.enqueue(req('s1', 'sched_1', 'sched', 'run'));
    expect(q.pendingCount).toBe(2);
    expect(q.deduped).toBe(2);
  });

  it('does not coalesce across kinds for the same jobID', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'j1', 'mon', 'same'));
    q.enqueue(req('s1', 'j1', 'bg', 'same'));
    expect(q.pendingCount).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('does not coalesce across sessions', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'mon_1', 'mon', 'window'));
    q.enqueue(req('s2', 'mon_1', 'mon', 'window'));
    expect(q.pendingCount).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('preserves order: coalesced entry keeps its original position', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_1', 'bg', 'first'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'mid'));
    q.enqueue(req('s1', 'sched_1', 'sched', 'last'));
    // Coalesce mon_1 two more times
    q.enqueue(req('s1', 'mon_1', 'mon', 'mid'));
    q.enqueue(req('s1', 'mon_1', 'mon', 'mid'));
    q.setSessionStatus('idle');
    expect(delivered.map((d) => d.jobID)).toEqual(['bg_1', 'mon_1', 'sched_1']);
  });

  it('deduped entry is evictable by FIFO (caps stay enforced)', () => {
    const q = new IdleQueue('busy', deliveryStub);
    // Fill to the global cap with deduped mon entries (each a distinct job → distinct key)
    for (let i = 0; i < MAX_PENDING_GLOBAL; i++) {
      q.enqueue(req('s1', `mon_${i}`, 'mon', 'window'));
    }
    expect(q.pendingCount).toBeLessThanOrEqual(MAX_PENDING_GLOBAL);
    // One more distinct job pushes over the global cap → #evictFifo must evict a deduped entry
    q.enqueue(req('s1', 'mon_overflow', 'mon', 'window'));
    expect(q.pendingCount).toBeLessThanOrEqual(MAX_PENDING_GLOBAL);
    expect(q.dropped).toBeGreaterThanOrEqual(1);
  });

  it('per-job cap evicts a deduped entry and clears its dedupKey', () => {
    const q = new IdleQueue('busy', deliveryStub);
    // MAX_PENDING_PER_JOB distinct payloads for the same job → each is a separate dedupKey
    for (let i = 0; i < MAX_PENDING_PER_JOB; i++) {
      q.enqueue(req('s1', 'mon_1', 'mon', `w_${i}`));
    }
    expect(q.pendingCount).toBe(MAX_PENDING_PER_JOB);
    // One more distinct payload for the same job triggers per-job eviction
    q.enqueue(req('s1', 'mon_1', 'mon', 'w_overflow'));
    expect(q.pendingCount).toBe(MAX_PENDING_PER_JOB);
    // The evicted payload's dedupKey must be gone: re-enqueueing it must be fresh, not coalesced
    q.enqueue(req('s1', 'mon_1', 'mon', 'w_0'));
    const entry = q.peek().find((e) => e.req.text === 'w_0');
    expect(entry?.dedupCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/idle-queue.test.ts`
Expected: FAIL — `q.deduped is not a function` / `entry.dedupCount is undefined` / annotation string missing.

- [ ] **Step 3: Add imports and entry fields**

In `src/bridge/idle-queue.ts`:

Add this import immediately after the existing `import { monitorDebug } from '../debug-log.js';` line:

```typescript
import { dedupKey, isDedupEligible } from '../delivery/dedup.js';
```

Replace the entire `IdlePendingEntry` interface (the block starting with `export interface IdlePendingEntry {` and ending with its closing `}`) with:

```typescript
export interface IdlePendingEntry {
  req: AutoSubmitRequest;
  byteSize: number;
  /** true for /loop coalesced entries */
  coalesced?: boolean;
  /** tick count carried only for /loop coalesced entries */
  coalescedTickCount?: number;
  /** dedupKey stored on the entry so removal can clear the index without a reverse lookup */
  dedupKey?: string;
  /** repeat count for content dedup (mon/bg/sched); absent or 1 means no dedup */
  dedupCount?: number;
}
```

- [ ] **Step 4: Add dedup state fields and getter**

In `src/bridge/idle-queue.ts`, locate the field declaration `#nextEntryID = 0;` and add these two fields immediately after it:

```typescript
  #dedupIndex: Map<string, string> = new Map();
  #deduped = 0;
```

Then locate the `pendingCount` getter (the block `get pendingCount(): number { return this.#pending.size; }`) and add this getter immediately after its closing `}`:

```typescript
  /** Count of content-deduplicated enqueues (coalesced into an existing entry). */
  get deduped(): number {
    return this.#deduped;
  }
```

- [ ] **Step 5: Rewrite `#enqueueStandard` with dedup coalescing**

Replace the entire `#enqueueStandard` method (the block starting with `#enqueueStandard(req: AutoSubmitRequest, byteSize: number): void {` through its closing `}` — currently a 15-line method) with:

```typescript
  #enqueueStandard(req: AutoSubmitRequest, byteSize: number): void {
    // Content dedup: if an identical eligible payload is already pending,
    // coalesce in place — replace req, bump dedupCount, keep position.
    // Returns before #applyCaps so dedup never triggers eviction.
    if (isDedupEligible(req.kind)) {
      const dk = dedupKey(req);
      const existingKey = this.#dedupIndex.get(dk);
      if (existingKey !== undefined) {
        const existing = this.#pending.get(existingKey);
        if (existing) {
          const prevBytes = existing.byteSize;
          existing.req = req;
          existing.byteSize = byteSize;
          existing.dedupCount = (existing.dedupCount ?? 1) + 1;
          this.byteSize += byteSize - prevBytes;
          this.#deduped += 1;
          monitorDebug('idleQueue.dedup', { sessionID: req.sessionID, jobID: req.jobID, kind: req.kind, dedupCount: existing.dedupCount });
          return;
        }
        // Stale index entry (should not happen) — fall through to normal enqueue.
        this.#dedupIndex.delete(dk);
      }
    }

    const key = this.#standardKey(req);
    const entry: IdlePendingEntry = { req, byteSize };
    this.#applyCaps();

    // Per-job cap: check count for this specific job before enqueueing
    const jobEntries = this.#countJobEntries(req.sessionID, req.jobID);
    if (jobEntries >= MAX_PENDING_PER_JOB) {
      this.#evictOldestForJob(req.sessionID, req.jobID);
    }

    this.#pending.set(key, entry);
    this.#globalOrder.push(key);
    this.byteSize += byteSize;

    if (isDedupEligible(req.kind)) {
      const dk = dedupKey(req);
      entry.dedupKey = dk;
      entry.dedupCount = 1;
      this.#dedupIndex.set(dk, key);
    }
  }
```

- [ ] **Step 6: Clear dedupKey in every removal path**

Add a small private helper method. Place it immediately before the `#requestForDelivery` method (anchor: the line `#requestForDelivery(entry: IdlePendingEntry): AutoSubmitRequest {`):

```typescript
  /** Clear an entry's dedupKey from the index, if it has one. */
  #clearDedupKey(entry: IdlePendingEntry): void {
    if (entry.dedupKey !== undefined) {
      this.#dedupIndex.delete(entry.dedupKey);
    }
  }

```

There are **four** `this.#pending.delete(key);` call sites in the file. Each must be preceded by a `this.#clearDedupKey(entry);` call. The `entry` variable is in scope at all four sites. Use Edit with `replace_all: false` and enough surrounding context to make each match unique:

**Site 1 — `#shiftAndDeliver`** (the one followed by `this.byteSize -= entry.byteSize;` then `return ok;`). Replace:

```typescript
    this.#pending.delete(key);
    this.byteSize -= entry.byteSize;
    return ok;
```

with:

```typescript
    this.#clearDedupKey(entry);
    this.#pending.delete(key);
    this.byteSize -= entry.byteSize;
    return ok;
```

**Site 2 — targeted-flush branch of `flush`** (the one followed by `this.#globalOrder.splice(idx, 1);` then `this.byteSize -= entry.byteSize;` then `if (!ok) break;`). Replace:

```typescript
          this.#pending.delete(key);
          this.#globalOrder.splice(idx, 1);
          this.byteSize -= entry.byteSize;
          if (!ok) break;
```

with:

```typescript
          this.#clearDedupKey(entry);
          this.#pending.delete(key);
          this.#globalOrder.splice(idx, 1);
          this.byteSize -= entry.byteSize;
          if (!ok) break;
```

**Sites 3 & 4 — `#evictFifo` and `#evictOldestForJob`** (both have a structurally identical four-line removal body ending with `this.dropped += 1;` then `}`). Both need the same `this.#clearDedupKey(entry);` insertion. Since the body is identical across both methods, use a single Edit with `replace_all: true` to update both at once. Replace all occurrences of:

```typescript
    this.#pending.delete(key);
    this.#globalOrder.splice(idx, 1);
    this.byteSize -= entry.byteSize;
    this.dropped += 1;
  }
```

with (all occurrences):

```typescript
    this.#clearDedupKey(entry);
    this.#pending.delete(key);
    this.#globalOrder.splice(idx, 1);
    this.byteSize -= entry.byteSize;
    this.dropped += 1;
  }
```

This updates both `#evictFifo` and `#evictOldestForJob` in one edit.

After all edits, verify by searching the file: every `this.#pending.delete(key);` must now be immediately preceded by `this.#clearDedupKey(entry);`. There should be exactly four of each.

- [ ] **Step 7: Extend `#requestForDelivery` with dedup annotation**

Replace the entire `#requestForDelivery` method (the block starting with `#requestForDelivery(entry: IdlePendingEntry): AutoSubmitRequest {` through its closing `}`) with:

```typescript
  #requestForDelivery(entry: IdlePendingEntry): AutoSubmitRequest {
    // /loop coalescing annotation (unchanged)
    const count = entry.coalescedTickCount ?? 1;
    if (entry.coalesced && count > 1) {
      return {
        ...entry.req,
        text: `${entry.req.text}\n\n[coalesced ${count} loop ticks while session was busy]`,
      };
    }
    // Content dedup annotation (mon/bg/sched) — distinct wording
    const dedup = entry.dedupCount ?? 1;
    if (dedup > 1) {
      return {
        ...entry.req,
        text: `${entry.req.text}\n\n[deduped ${dedup} identical messages while session was busy]`,
      };
    }
    return entry.req;
  }
```

- [ ] **Step 8: Include `deduped` in the existing enqueue debug log**

Locate the `monitorDebug('idleQueue.enqueue', { ... })` call inside the `enqueue` method (it currently logs `dropped: this.dropped, byteSize: this.byteSize`). Add `deduped: this.deduped` so the dedup counter is visible alongside `dropped` in debug output. Replace:

```typescript
    monitorDebug('idleQueue.enqueue', { sessionID: req.sessionID, jobID: req.jobID, kind: req.kind, pendingCount: this.pendingCount, dropped: this.dropped, byteSize: this.byteSize });
```

with:

```typescript
    monitorDebug('idleQueue.enqueue', { sessionID: req.sessionID, jobID: req.jobID, kind: req.kind, pendingCount: this.pendingCount, dropped: this.dropped, deduped: this.deduped, byteSize: this.byteSize });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run test/idle-queue.test.ts`
Expected: PASS — all new dedup tests green, all existing tests (including the `coalesced 3 loop ticks` assertion) still pass.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/bridge/idle-queue.ts test/idle-queue.test.ts
git commit -m "feat(idle-queue): coalesce duplicate standard entries while busy"
```

---

### Task 3: DeliveryQueue — drop-on-duplicate

**Parallel:** after Task 1 (parallelizable with Task 2 — disjoint files)
**Touches:** `src/delivery/delivery-queue.ts`, `test/delivery-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/delivery-queue.test.ts` (new describe block at end of file):

```typescript
// ----------------------------------------------------------------
// Content dedup
// ----------------------------------------------------------------

describe('DeliveryQueue content dedup', () => {
  it('drops duplicate eligible payloads and counts them', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'window'));
    q.enqueue(req('mon_1', 'mon', 'window'));
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
    expect(q.deduped).toBe(2);
    expect(q.dropped).toBe(2);
  });

  it('keeps distinct payloads separate', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'a'));
    q.enqueue(req('mon_1', 'mon', 'b'));
    expect(q.length).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('does not dedup loop entries', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('loop_1', 'loop', 'tick'));
    q.enqueue(req('loop_1', 'loop', 'tick'));
    expect(q.length).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('accepts the same payload again after drain clears the key', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'window'));
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
    q.drain();
    expect(q.length).toBe(0);
    // After drain, an identical payload is a fresh event
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
    expect(q.deduped).toBe(2); // unchanged by the post-drain enqueue
  });

  it('accepts the same payload again after flush clears the key', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'window'));
    let count = 0;
    q.flush(() => { count += 1; return true; });
    expect(count).toBe(1);
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
  });

  it('clears dedupKey when an expired entry is pruned', () => {
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => 0);
    const q = new DeliveryQueue();
    q.enqueue(req('old', 'mon', 'window'));
    // Move time forward past expiry so #pruneExpired drops 'old/window' on next enqueue
    spy.mockImplementation(() => BRIDGE_UNAVAILABLE_EXPIRY_MS + 1);
    q.enqueue(req('new', 'mon', 'other'));
    // The expired 'old'/'window' key must be gone — re-enqueueing it is accepted as fresh
    q.enqueue(req('old', 'mon', 'window'));
    expect(q.length).toBe(2); // 'new/other' + 'old/window' re-accepted after TTL prune
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/delivery-queue.test.ts`
Expected: FAIL — `q.deduped is not a function` / length not 1.

- [ ] **Step 3: Add imports**

In `src/delivery/delivery-queue.ts`, add these two imports immediately after the existing `import { BRIDGE_UNAVAILABLE_EXPIRY_MS } from '../limits.js';` line:

```typescript
import { dedupKey, isDedupEligible } from './dedup.js';
import { monitorDebug } from '../debug-log.js';
```

- [ ] **Step 4: Add dedup state and getter**

In the `DeliveryQueue` class, locate the field `#dropped = 0;` and add these two fields immediately after it:

```typescript
  #dedupKeys: Set<string> = new Set();
  #deduped = 0;
```

Then locate the `get dropped()` getter and add this getter immediately after its closing `}`:

```typescript
  get deduped(): number {
    return this.#deduped;
  }
```

- [ ] **Step 5: Add dedup check to `enqueue`**

Replace the entire `enqueue` method (the block starting with `enqueue(req: AutoSubmitRequest): void {` through its closing `}`) with:

```typescript
  enqueue(req: AutoSubmitRequest): void {
    this.#pruneExpired();
    if (isDedupEligible(req.kind)) {
      const dk = dedupKey(req);
      if (this.#dedupKeys.has(dk)) {
        this.#deduped += 1;
        this.#dropped += 1;
        monitorDebug('deliveryQueue.dedup', { sessionID: req.sessionID, jobID: req.jobID, kind: req.kind });
        return;
      }
      this.#dedupKeys.add(dk);
    }
    this.#pending.push({
      req,
      enqueuedAt: Date.now(),
    });
  }
```

- [ ] **Step 6: Clear dedupKeys on drain and flush**

In the `drain` method, locate the line `this.#pending.length = 0;` and add a clear immediately after it:

```typescript
    this.#pending.length = 0;
    this.#dedupKeys.clear();
```

In the `flush` method, locate the line `this.#pending = remaining;` (the last statement before the method returns) and add a clear immediately after it:

```typescript
    this.#pending = remaining;
    this.#dedupKeys.clear();
```

- [ ] **Step 7: Clear expired entries' dedupKeys in `#pruneExpired`**

Replace the entire `#pruneExpired` method (the block starting with `#pruneExpired(): number {` through its closing `}`) with:

```typescript
  #pruneExpired(): number {
    const now = Date.now();
    const expiry = BRIDGE_UNAVAILABLE_EXPIRY_MS;
    let pruned = 0;
    const remaining: DeliveryPendingEntry[] = [];

    for (const entry of this.#pending) {
      if (now - entry.enqueuedAt >= expiry) {
        if (isDedupEligible(entry.req.kind)) {
          this.#dedupKeys.delete(dedupKey(entry.req));
        }
        this.#dropped += 1;
        pruned += 1;
      } else {
        remaining.push(entry);
      }
    }

    this.#pending = remaining;
    return pruned;
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/delivery-queue.test.ts`
Expected: PASS — all new dedup tests green, all existing tests still pass.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/delivery/delivery-queue.ts test/delivery-queue.test.ts
git commit -m "feat(delivery-queue): drop duplicate payloads while bridge down"
```

---

### Task 4: Full suite regression + integration end-to-end

**Parallel:** after Tasks 2 and 3
**Touches:** `test/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Append to `test/integration.test.ts` (new `it` inside the top-level `describe('opencode monitor plugin integration', ...)` block, immediately after the existing `'coalesces loop backlog into one idle delivery with tick count metadata'` test):

```typescript
  it('deduplicates identical monitor deliveries while busy into one annotated delivery', async () => {
    const delivered: AppendNotification[] = [];
    const { server, configPath } = await startBridge(delivered);
    server.setSessionStatus('s1', 'busy');

    for (let i = 0; i < 3; i++) {
      await appendSubmitToSession({ sessionID: 's1', jobID: 'mon_1', kind: 'mon', text: 'window', submit: true }, configPath);
    }
    expect(delivered).toEqual([]);

    server.setSessionStatus('s1', 'idle');
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].params.text).toContain('window');
    expect(delivered[0].params.text).toContain('[deduped 3 identical messages while session was busy]');
  });
```

- [ ] **Step 2: Run the new test**

This is a **confirmation test**, not a red-green cycle: Tasks 2 and 3 already implemented the feature, so this test should pass immediately. If it fails, Tasks 2/3 are broken — debug before proceeding.

Run: `npx vitest run test/integration.test.ts -t "deduplicates identical monitor"`
Expected: PASS — exactly one delivery with the `[deduped 3 identical messages while session was busy]` annotation. If it FAILS (e.g. delivered length is 3, or annotation missing), do NOT proceed to Step 3 — go back and fix the IdleQueue/DeliveryQueue implementation.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the existing `coalesced 3 loop ticks` assertions in `test/idle-queue.test.ts` and `test/integration.test.ts` (unchanged).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add test/integration.test.ts
git commit -m "test(integration): cover monitor dedup end-to-end"
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: compiles cleanly, `dist/` updated.

- [ ] **Step 7: Commit build artifacts if tracked**

Check: `git status --porcelain dist/`
If `dist/` is gitignored, skip. If tracked, commit:

```bash
git add dist/
git commit -m "build: compile queue dedup"
```