import { Worker } from 'worker_threads';
import {
  REDOS_MAX_CONCURRENT,
  REDOS_MAX_QUEUED_PER_MONITOR,
  REDOS_TIMEOUT_MS,
} from '../limits.js';

// ----------------------------------------------------------------
// Re-export limits for callers that import them from this module.
export {
  REDOS_MAX_CONCURRENT,
  REDOS_MAX_QUEUED_PER_MONITOR,
  REDOS_TIMEOUT_MS,
} from '../limits.js';

// ----------------------------------------------------------------
// Errors
// ----------------------------------------------------------------

export class RedosTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'ReDoS regex check timed out');
    this.name = 'RedosTimeoutError';
  }
}

// ----------------------------------------------------------------
// Pool
// ----------------------------------------------------------------

interface QueueEntry {
  resolve: (v: WorkerResult) => void;
  reject: (e: Error) => void;
  pattern: string;
  flags: string;
  text: string;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
  isTimedOut(): boolean;
}

interface WorkerResult {
  ok: true;
  matched: boolean;
}

interface WorkerError {
  ok: false;
  error: string;
}

type WorkerMessage = WorkerResult | WorkerError;

class WorkerPool {
  #pool = new Set<Worker>();
  #pending = 0;
  #queue: QueueEntry[] = [];
  #workerUrl = new URL(
    import.meta.url.endsWith('.ts') ? 'redos-thread.ts' : 'redos-thread.js',
    import.meta.url,
  );

  post(pattern: string, flags: string, text: string, timeoutMs: number): Promise<WorkerResult> {
    if (this.#pending < REDOS_MAX_CONCURRENT) {
      return this.#run(pattern, flags, text, timeoutMs);
    }
    if (this.#queue.length >= REDOS_MAX_QUEUED_PER_MONITOR) {
      throw new RedosTimeoutError('ReDoS queue full');
    }
    let timedOut = false;
    return new Promise<WorkerResult>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        pattern,
        flags,
        text,
        timeoutMs,
        timer: setTimeout(() => {
          timedOut = true;
          const idx = this.#queue.indexOf(entry);
          if (idx !== -1) this.#queue.splice(idx, 1);
          reject(new RedosTimeoutError());
        }, timeoutMs),
        isTimedOut() { return timedOut; },
      };
      this.#queue.push(entry);
    });
  }

  #run(
    pattern: string,
    flags: string,
    text: string,
    timeoutMs: number,
  ): Promise<WorkerResult> {
    this.#pending += 1;

    const worker = new Worker(
      this.#workerUrl,
      { workerData: { pattern, flags, text } },
    );
    this.#pool.add(worker);

    return new Promise<WorkerResult>((resolve, reject) => {
      let settled = false;
      const settle = (ok: boolean, result: WorkerResult | Error) => {
        if (settled) return;
        settled = true;
        ok ? resolve(result as WorkerResult) : reject(result as Error);
      };

      const timer = setTimeout(() => {
        worker.terminate();
        settle(false, new RedosTimeoutError());
      }, timeoutMs);

      worker.once('message', (msg: WorkerMessage) => {
        clearTimeout(timer);
        if ((msg as WorkerResult).ok) {
          settle(true, msg as WorkerResult);
        } else {
          settle(false, new Error((msg as WorkerError).error));
        }
      });

      worker.once('error', (err) => {
        clearTimeout(timer);
        settle(false, err);
      });

      worker.once('exit', () => {
        this.#freeSlot(worker);
      });
    });
  }

  #freeSlot(worker: Worker): void {
    if (!this.#pool.has(worker)) return;
    this.#pool.delete(worker);
    if (this.#pending > 0) this.#pending -= 1;
    // Drain the head of the queue, skipping entries that already timed out.
    while (this.#queue.length > 0 && this.#pending < REDOS_MAX_CONCURRENT) {
      const entry = this.#queue.shift()!;
      if (entry.isTimedOut()) {
        // The promise already rejected; skip and try the next entry.
        clearTimeout(entry.timer);
        continue;
      }
      clearTimeout(entry.timer);
      this.#run(entry.pattern, entry.flags, entry.text, entry.timeoutMs)
        .then(entry.resolve, entry.reject);
    }
  }

  close(): Promise<void> {
    this.#queue.forEach((e) => clearTimeout(e.timer));
    this.#queue.length = 0;
    const promises: Promise<void>[] = [];
    for (const w of this.#pool) {
      promises.push(new Promise<void>((r) => { w.once('exit', r); w.terminate(); }));
    }
    this.#pool.clear();
    return Promise.all(promises).then(() => {});
  }
}

// ----------------------------------------------------------------
// ReDoSWorker — user-facing API
// ----------------------------------------------------------------
// A safe async wrapper for regex checks.
// - Uses an internal WorkerPool for sandboxed execution.
// - `test()` returns whether `pattern` (+ flags) matches `text`.
// - `check()` is a convenience alias (no flags, default timeout).
// - `close()` shuts down all workers.

export class ReDoSWorker {
  #pool = new WorkerPool();
  #closed = false;

  /**
   * Test `pattern` against `text`, optionally with regex `flags` and a `timeoutMs` override.
   */
  test(
    pattern: string,
    flags: string,
    text: string,
    timeoutMs: number = REDOS_TIMEOUT_MS,
  ): Promise<boolean> {
    if (this.#closed) return Promise.reject(new RedosTimeoutError('worker closed'));
    return this.#pool.post(pattern, flags, text, timeoutMs).then((r) => r.matched);
  }

  /**
   * Convenience alias: test without explicit flags, using default timeout.
   */
  check(pattern: string, text: string, timeoutMs: number = REDOS_TIMEOUT_MS): Promise<boolean> {
    return this.test(pattern, '', text, timeoutMs);
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#pool.close();
  }
}

export default ReDoSWorker;
