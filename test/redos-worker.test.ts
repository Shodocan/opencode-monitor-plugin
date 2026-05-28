import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ReDoSWorker, RedosTimeoutError } from '../src/runner/redos-worker.js';
import { REDOS_TIMEOUT_MS, REDOS_MAX_CONCURRENT, REDOS_MAX_QUEUED_PER_MONITOR } from '../src/limits.js';

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('ReDoSWorker', () => {
  let worker: ReDoSWorker;

  beforeEach(() => {
    worker = new ReDoSWorker();
  });

  afterEach(async () => {
    await worker.close().catch(() => {});
  });

  // -- Basic matches ------------------------------------------

  it('returns true for matching pattern', async () => {
    const matched = await worker.test('hello', '', 'hello world', 1_000);
    expect(matched).toBe(true);
  });

  it('returns false for non-matching pattern', async () => {
    const matched = await worker.test('xyz', '', 'hello world', 1_000);
    expect(matched).toBe(false);
  });

  it('rejects with RedosTimeoutError on intentional timeout', async () => {
    const pattern = 'a{0,1000000}';
    const text = 'a'.repeat(20);
    await expect(worker.test(pattern, '', text, 1)).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  it('rejects with RedosTimeoutError after close()', async () => {
    await worker.close();
    await expect(worker.test('x', '', 'x')).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  // -- check() alias -------------------------------------------

  it('check() is a no-flags alias for test()', async () => {
    const matched = await worker.check('hello', 'hello world', 1_000);
    expect(matched).toBe(true);
  });

  // -- Flags --------------------------------------------------

  it('respects regex flags via test()', async () => {
    const matched = await worker.test('hello', 'i', 'HELLO world', 1_000);
    expect(matched).toBe(true);
  });

  // -- Constants ------------------------------------------------

  it('respects REDOS_TIMEOUT_MS constant', () => {
    expect(REDOS_TIMEOUT_MS).toBe(100);
  });

  it('respects REDOS_MAX_CONCURRENT constant', () => {
    expect(REDOS_MAX_CONCURRENT).toBe(4);
  });

  it('respects REDOS_MAX_QUEUED_PER_MONITOR constant', () => {
    expect(REDOS_MAX_QUEUED_PER_MONITOR).toBe(10);
  });

  // -- Concurrency stress -------------------------------------

  it('handles multiple concurrent checks without deadlock', async () => {
    const promises = Array.from({ length: REDOS_MAX_CONCURRENT * 2 }, (_, i) =>
      worker.test(`^test${i}$`, '', `test${i}`, 1_000),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r === true)).toBe(true);
  });

  // -- Queue overflow -------------------------------------------

  it('rejects with RedosTimeoutError on queue overflow', () => {
    // Saturate pool + queue: MAX_CONCURRENT running + MAX_QUEUED queued = at capacity.
    // The (MAX_CONCURRENT + MAX_QUEUED + 1)-th call throws.
    const pending = Array.from({ length: REDOS_MAX_CONCURRENT + REDOS_MAX_QUEUED_PER_MONITOR }, () =>
      worker.test('long', '', 'a'.repeat(1_000_000)),
    );
    expect(() => worker.test('overflow', '', 'x')).toThrow('ReDoS queue full');
    Promise.allSettled(pending);
  });

  // -- Slot cleanup on timeout ---------------------------------

  it('frees pool slots after timed-out workers', async () => {
    // Saturate all REDOS_MAX_CONCURRENT slots with very short timeouts
    const pending = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      worker.test('x', '', 'x', 1), // 1ms timeout — will almost certainly expire
    );

    // All 4 should reject (or at least most)
    const results = await Promise.allSettled(pending);
    // At least some rejections expected
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);

    // After timeouts, a new request must succeed — slots must be freed
    const matched = await worker.test('y', '', 'y');
    expect(matched).toBe(true);
    await worker.close();
  });

  it('pool remains functional after multiple rounds of timeouts', async () => {
    // Round 1: saturate and timeout
    const round1 = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      worker.test('timeout', '', 'timeout', 1),
    );
    await Promise.allSettled(round1);

    // Round 2: should all succeed normally (slots were freed in round 1)
    const round2 = Array.from({ length: REDOS_MAX_CONCURRENT }, (_, i) =>
      worker.test('ok' + i, '', 'ok' + i),
    );
    const results = await Promise.all(round2);
    expect(results.every((r) => r === true)).toBe(true);
    await worker.close();
  });

  // -- Queue staleness ------------------------------------------

  it('cleans timed-out queue entries and serves fresh new requests', async () => {
    const w = new ReDoSWorker();

    // 1. Saturate all concurrent slots with very short timeout workers.
    const saturate = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      w.test('slow', '', 'a'.repeat(100_000), 1),
    );

    // 2. Fill the queue with entries that time out before any worker frees a slot.
    const queueEntries: Promise<boolean>[] = Array.from(
      { length: REDOS_MAX_QUEUED_PER_MONITOR },
      (_, i) => w.test('q' + i, '', 'q' + i, 1),
    );
    const queueSettled = Promise.allSettled(queueEntries);

    // 3. Workers finish → freeSlot drains stale queue entries.
    await Promise.allSettled(saturate);

    // 4. Queue entries are rejected by their own timers.
    await queueSettled;

    // 5. A fresh request must succeed — queue is clean.
    const result = await w.test('final', '', 'final');
    expect(result).toBe(true);
    await w.close();
  });

  // -- Queue staleness: explicit size after timeout ------------

  it('new requests see clean queue after mass queue-timeout', async () => {
    const w = new ReDoSWorker();

    // Block all workers with a pattern that will genuinely take > 200ms.
    const blocker = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      w.test('long', '', 'abc'.repeat(500_000), 200),
    );

    // Fill the queue entirely with entries that time out in 2ms.
    const queued = Array.from({ length: REDOS_MAX_QUEUED_PER_MONITOR }, () =>
      w.test('quick', '', 'q', 2),
    );
    const queuedSettled = Promise.allSettled(queued);

    // The very next call must throw because queue is full.
    expect(() => w.test('overflow', '', 'x')).toThrow('ReDoS queue full');

    // Queue entries time out before workers finish; they must be removed from #queue.
    const settled = await queuedSettled;
    expect(settled.every((r) => r.status === 'rejected')).toBe(true);

    // Workers finish → freed slots drain stale entries, not re-run them.
    await Promise.allSettled(blocker);

    // A fresh request must succeed.
    const ok = await w.test('recovery', '', 'recovery');
    expect(ok).toBe(true);
    await w.close();
  });

  // -- close() -------------------------------------------------

  it('close() shuts down pool and allows new instance', async () => {
    await worker.test('a', '', 'a');
    await worker.close();
    const w2 = new ReDoSWorker();
    expect(await w2.test('b', '', 'b')).toBe(true);
    await w2.close();
  });

  it('close() settles active and queued checks', async () => {
    const w = new ReDoSWorker();
    const slowPattern = '^(a+)+$';
    const slowText = `${'a'.repeat(32)}!`;

    const active = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      w.test(slowPattern, '', slowText, 10_000),
    );
    const queued = w.test('queued', '', 'queued', 10_000);
    const allSettled = Promise.allSettled([...active, queued]);

    await w.close();

    const settled = await Promise.race([
      allSettled,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(settled).not.toBe('timeout');
    expect((settled as PromiseSettledResult<boolean>[]).every((r) => r.status === 'rejected')).toBe(true);
  });
});
