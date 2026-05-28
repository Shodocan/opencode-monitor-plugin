import { describe, expect, it, beforeEach } from 'vitest';
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

  // -- Basic matches ------------------------------------------

  it('returns true for matching pattern', async () => {
    const matched = await worker.test('hello', '', 'hello world');
    expect(matched).toBe(true);
  });

  it('returns false for non-matching pattern', async () => {
    const matched = await worker.test('xyz', '', 'hello world');
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
    const matched = await worker.check('hello', 'hello world');
    expect(matched).toBe(true);
  });

  // -- Flags --------------------------------------------------

  it('respects regex flags via test()', async () => {
    const matched = await worker.test('hello', 'i', 'HELLO world');
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
      worker.test(`^test${i}$`, '', `test${i}`),
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

  // -- close() -------------------------------------------------

  it('close() shuts down pool and allows new instance', async () => {
    await worker.test('a', '', 'a');
    await worker.close();
    const w2 = new ReDoSWorker();
    expect(await w2.test('b', '', 'b')).toBe(true);
    await w2.close();
  });
});
