import { describe, expect, it } from 'vitest';
import { ReDoSWorker, RedosTimeoutError } from '../src/runner/redos-worker.js';
import { REDOS_TIMEOUT_MS, REDOS_MAX_CONCURRENT, REDOS_MAX_QUEUED_PER_MONITOR } from '../src/limits.js';

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('ReDoSWorker', () => {
  let worker: ReDoSWorker;

  // -- Basic matches ------------------------------------------

  it('returns true for matching pattern', async () => {
    worker = new ReDoSWorker();
    const matched = await worker.check('hello', 'hello world');
    expect(matched).toBe(true);
  });

  it('returns false for non-matching pattern', async () => {
    worker = new ReDoSWorker();
    const matched = await worker.check('xyz', 'hello world');
    expect(matched).toBe(false);
  });

  it('rejects with RedosTimeoutError on intentional timeout', async () => {
    worker = new ReDoSWorker();
    // Use a pathologically slow pattern against a large string
    // (a{0,1000000} against "aaaaaaaaaaaaaaaaaa" forces backtracking)
    const pattern = 'a{0,1000000}';
    const text = 'a'.repeat(20);
    // Very short timeout to force timeout
    await expect(worker.check(pattern, text, 1)).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  it('throws RedosTimeoutError after close()', async () => {
    worker = new ReDoSWorker();
    await worker.close();
    await expect(worker.check('x', 'x')).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  // -- Worker pool: concurrency limits --------------------------

  it('respects REDOS_TIMEOUT_MS constant', () => {
    expect(REDOS_TIMEOUT_MS).toBe(100);
  });

  it('respects REDOS_MAX_CONCURRENT constant', () => {
    expect(REDOS_MAX_CONCURRENT).toBe(4);
  });

  it('respects REDOS_MAX_QUEUED_PER_MONITOR constant', () => {
    expect(REDOS_MAX_QUEUED_PER_MONITOR).toBe(10);
  });

  // -- Concurrency stress: many simultaneous requests ----------

  it('handles multiple concurrent checks without deadlock', async () => {
    worker = new ReDoSWorker();
    const promises = Array.from({ length: REDOS_MAX_CONCURRENT * 2 }, (_, i) =>
      worker.check(`^test${i}$`, `test${i}`),
    );
    const results = await Promise.all(promises);
    expect(results.every((r) => r === true)).toBe(true);
  });

  // -- close() -------------------------------------------------

  it('close() shuts down pool and allows new instance', async () => {
    worker = new ReDoSWorker();
    await worker.check('a', 'a');
    await worker.close();
    // Fresh instance works after old one is closed
    const w2 = new ReDoSWorker();
    expect(await w2.check('b', 'b')).toBe(true);
    await w2.close();
  });
});
