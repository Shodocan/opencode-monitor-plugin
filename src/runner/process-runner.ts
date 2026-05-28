import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Readable } from 'stream';
import {
  CANCEL_SIGKILL_TIMEOUT_MS,
  PROCESS_OUTPUT_CAP_BYTES,
  PROCESS_OUTPUT_CAP_LINES,
} from '../limits.js';
import type { OutputEvent, OutputStream } from '../types.js';

// ----------------------------------------------------------------
// Errors
// ----------------------------------------------------------------

export class ProcessRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessRunnerError';
  }
}

// ----------------------------------------------------------------
// Tail buffer — rolling window per stream
// ----------------------------------------------------------------

class TailBuffer {
  #lines: string[] = [];
  #bytes = 0;
  #maxLines: number;
  #maxBytes: number;

  constructor(maxLines: number, maxBytes: number) {
    this.#maxLines = maxLines;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#lines.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  add(line: string): void {
    const len = Buffer.byteLength(line, 'utf8');
    this.#lines.push(line);
    this.#bytes += len;
    while (this.#lines.length > this.#maxLines || this.#bytes > this.#maxBytes) {
      const dropped = this.#lines.shift()!;
      this.#bytes -= Buffer.byteLength(dropped, 'utf8');
    }
  }

  snapshot(): string[] {
    return [...this.#lines];
  }
}

// ----------------------------------------------------------------
// ProcessRunner
// ----------------------------------------------------------------

export interface ProcessRunnerEvents {
  output: OutputEvent;
}

interface ProcessHandle {
  process: ChildProcess;
  exitPromise: Promise<number | null>;
  cancelPending: boolean;
  cancelled: boolean;
}

export class ProcessRunner extends EventEmitter {
  #handles = new Map<string, ProcessHandle>();
  // jobID -> stdout/stderr -> TailBuffer
  #tails = new Map<string, Map<OutputStream, TailBuffer>>();

  /**
   * Spawn a POSIX shell command.
   * Returns { jobID, exitPromise }.
   *
   * - `detached: true` so the process runs in its own process group.
   * - The exit promise is created at spawn time (no race for fast commands).
   * - Output is emitted as `OutputEvent` lines; trailing empty-lines are dropped.
   * - Rolling tails enforce per-stream caps while streams keep draining.
   */
  run(jobID: string, command: string): { jobID: string; exitPromise: Promise<number | null> } {
    if (this.#handles.has(jobID)) {
      throw new ProcessRunnerError(`job ${jobID} already running`);
    }

    const child = spawn('/bin/sh', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // spawn already does the shell thing
    });

    // Create the exit promise BEFORE attaching any listeners — avoids the
    // "fast process exits before handler attached" race. Use `close`, not
    // `exit`, so stdout/stderr have ended and final partial lines are flushed.
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('close', (code) => resolve(code));
    });

    void this.#onSpawn(jobID, child, exitPromise);
    return { jobID, exitPromise };
  }

  /**
   * Cancel a running job.
   * 1. SIGTERM to the process group (`kill(-pid)`).
   * 2. Wait up to `CANCEL_SIGKILL_TIMEOUT_MS`, then SIGKILL if alive.
   * 3. Fallback to `child.kill(signal)` when group-signal fails.
   *
   * Returns a promise that resolves when the process has actually exited.
   */
  async cancel(jobID: string): Promise<void> {
    const handle = this.#handles.get(jobID);
    if (!handle) {
      throw new ProcessRunnerError(`job ${jobID} not found`);
    }
    if (handle.cancelled) {
      return; // already done
    }
    handle.cancelled = true;

    // Phase 1 — SIGTERM
    this.#killGroup(handle.process, 'SIGTERM');

    // Phase 2 — SIGKILL after grace period
    await Promise.race([
      handle.exitPromise.then(() => {}),
      new Promise<void>((r) => setTimeout(r, CANCEL_SIGKILL_TIMEOUT_MS)),
    ]);

    if (handle.cancelPending) {
      // Still alive — bump it with SIGKILL
      this.#killGroup(handle.process, 'SIGKILL');
      // Final fallback: direct kill
      try {
        handle.process.kill('SIGKILL');
      } catch {
        /* process already gone */
      }
    }

    await handle.exitPromise;
  }

  /**
   * Get the rolling tail snapshot for a stream.
   */
  tail(jobID: string, stream: OutputStream): string[] {
    const map = this.#tails.get(jobID);
    if (!map) return [];
    const buf = map.get(stream);
    return buf ? buf.snapshot() : [];
  }

  /** Dispose a finished job (release memory). */
  dispose(jobID: string): void {
    this.#handles.delete(jobID);
    this.#tails.delete(jobID);
  }

  // -- Internal --------------------------------------------------

  #onSpawn(jobID: string, child: ChildProcess, exitPromise: Promise<number | null>): void {
    const tails = new Map<OutputStream, TailBuffer>([
      ['stdout', new TailBuffer(PROCESS_OUTPUT_CAP_LINES, PROCESS_OUTPUT_CAP_BYTES)],
      ['stderr', new TailBuffer(PROCESS_OUTPUT_CAP_LINES, PROCESS_OUTPUT_CAP_BYTES)],
    ]);

    this.#handles.set(jobID, { process: child, exitPromise, cancelPending: true, cancelled: false });
    this.#tails.set(jobID, tails);

    void this.#drainStream(jobID, child.stdout!, 'stdout', tails);
    void this.#drainStream(jobID, child.stderr!, 'stderr', tails);

    child.on('exit', () => {
      const h = this.#handles.get(jobID);
      if (h?.cancelPending) {
        h.cancelPending = false;
      }
    });
  }

  #drainStream(
    jobID: string,
    stream: Readable,
    type: OutputStream,
    tails: Map<OutputStream, TailBuffer>,
  ): void {
    let buffer = '';
    let seq = 0;

    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        // Trailing-empty suppression: if the line is empty and nothing
        // follows (no more data pending, buffer is empty), drop it.
        if (line.length === 0) {
          const more = stream.read();
          if (more !== null) {
            this.#emit(jobID, type, ++seq, line);
            tails.get(type)!.add(line);
          } else if (buffer.length > 0) {
            this.#emit(jobID, type, ++seq, line);
            tails.get(type)!.add(line);
          }
          // else: truly trailing newline at EOF — skip
          continue;
        }
        this.#emit(jobID, type, ++seq, line);
        tails.get(type)!.add(line);
      }
    });

    stream.once('end', () => {
      // Flush any remaining partial line (no trailing newline).
      if (buffer.length > 0) {
        this.#emit(jobID, type, ++seq, buffer);
        tails.get(type)!.add(buffer);
      }
    });
  }

  #emit(jobID: string, stream: OutputStream, seq: number, line: string): void {
    this.emit('output', {
      jobID,
      seq,
      stream,
      line,
      timestamp: Date.now(),
    } satisfies OutputEvent);
  }

  #killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    } catch {
      /* falls through to direct kill */
    }
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export default ProcessRunner;
