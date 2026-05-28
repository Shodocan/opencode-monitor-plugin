import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import type { JobKind, OutputStream } from '../types.js';

// ----------------------------------------------------------------
// Worker-side constants — inlined (ESM imports don't work in Worker threads)
// ----------------------------------------------------------------
export const REDOS_TIMEOUT_MS = 100;
export const REDOS_MAX_CONCURRENT = 4;
export const REDOS_MAX_QUEUED_PER_MONITOR = 10;

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
// Worker thread — cheap regex execution
// ----------------------------------------------------------------

if (isMainThread === false) {
  const data = workerData as { pattern: string; text: string };
  try {
    const re = new RegExp(data.pattern);
    const matched = re.test(data.text);
    parentPort?.postMessage({ ok: true as const, matched } as WorkerMessage);
  } catch (err) {
    parentPort?.postMessage({ ok: false as const, error: err instanceof Error ? err.message : String(err) } as WorkerMessage);
  }
}

// ----------------------------------------------------------------
// Pool
// ----------------------------------------------------------------
// Worker-side timeout (inlined because ESM imports don't work in Worker threads)
// ----------------------------------------------------------------

const REDOS_TIMEOUT_MS_INLINE = 100;

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
// Worker thread — cheap regex execution
// ----------------------------------------------------------------

if (isMainThread === false) {
  const data = workerData as { pattern: string; text: string };
  try {
    const re = new RegExp(data.pattern);
    const matched = re.test(data.text);
    parentPort?.postMessage({ ok: true as const, matched } as WorkerMessage);
  } catch (err) {
    parentPort?.postMessage({ ok: false as const, error: err instanceof Error ? err.message : String(err) } as WorkerMessage);
  }
}

// ----------------------------------------------------------------
// Pool
// ----------------------------------------------------------------

interface WorkerResult {
  ok: true;
  matched: boolean;
}

interface WorkerError {
  ok: false;
  error: string;
}

type WorkerMessage = WorkerResult | WorkerError;

const REDOS_MAX_CONCURRENT = 4;
const REDOS_MAX_QUEUED_PER_MONITOR = 10;

export { REDOS_TIMEOUT_MS_INLINE as REDOS_TIMEOUT_MS, REDOS_MAX_CONCURRENT, REDOS_MAX_QUEUED_PER_MONITOR };

class WorkerPool {
  #pool = new Set<Worker>();
  #pending = 0;
  #queue: Array<{
    resolve: (v: WorkerResult) => void;
    reject: (e: Error) => void;
    pattern: string;
    text: string;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  post(pattern: string, text: string, timeoutMs: number): Promise<WorkerResult> {
    if (this.#pending < REDOS_MAX_CONCURRENT) {
      return this.#run(pattern, text, timeoutMs);
    }
    if (this.#queue.length >= REDOS_MAX_QUEUED_PER_MONITOR) {
      throw new RedosTimeoutError('ReDoS queue full');
    }
    return new Promise<WorkerResult>((resolve, reject) => {
      this.#queue.push({
        resolve,
        reject,
        pattern,
        text,
        timer: setTimeout(() => reject(new RedosTimeoutError()), REDOS_TIMEOUT_MS_INLINE),
      });
    });
  }

  #run(pattern: string, text: string, timeoutMs: number): Promise<WorkerResult> {
    this.#pending += 1;

    const worker = new Worker(
      new URL('redos-worker.ts', import.meta.url),
      { workerData: { pattern, text } },
    );
    this.#pool.add(worker);

    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new RedosTimeoutError());
      }, timeoutMs);

      worker.once('message', (msg: WorkerMessage) => {
        clearTimeout(timer);
        worker.terminate();
        this.#freeSlot(worker);
        if ((msg as WorkerResult).ok) {
          resolve(msg as WorkerResult);
        } else {
          reject(new Error((msg as WorkerError).error));
        }
      });

      worker.once('error', (err) => {
        clearTimeout(timer);
        worker.terminate();
        this.#freeSlot(worker);
        reject(err);
      });
    });
  }

  #freeSlot(worker: Worker): void {
    this.#pool.delete(worker);
    this.#pending -= 1;
    if (this.#queue.length > 0 && this.#pending < REDOS_MAX_CONCURRENT) {
      const entry = this.#queue.shift()!;
      clearTimeout(entry.timer);
      this.#run(entry.pattern, entry.text, REDOS_TIMEOUT_MS_INLINE).then(entry.resolve, entry.reject);
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
  }}

// ----------------------------------------------------------------
// ReDoSWorker — user-facing API
// ----------------------------------------------------------------
// A safe async wrapper for regex checks.
// - Uses an internal WorkerPool for sandboxed execution.
// - `check()` returns whether `pattern` matches `text` or rejects with `RedosTimeoutError`.
// - `close()` shuts down all workers.

export class ReDoSWorker {
  #pool = new WorkerPool();
  #closed = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check(pattern: string, text: string, timeoutMs: number = 100): Promise<boolean> {
    if (this.#closed) throw new RedosTimeoutError('worker closed');
    return this.#pool.post(pattern, text, timeoutMs).then((r) => r.matched);
  }

  close(): Promise<void> {
    this.#closed = true;
    return this.#pool.close();
  }
}

export default ReDoSWorker;
