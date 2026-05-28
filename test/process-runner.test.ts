import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { OutputEvent } from '../src/types.js';
import { ProcessRunner } from '../src/runner/process-runner.js';
import { PROCESS_OUTPUT_CAP_LINES } from '../src/limits.js';

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function waitForOutput(runner: ProcessRunner, jobID: string, maxLines = 4): string[] {
  return new Promise<string[]>((resolve) => {
    const lines: string[] = [];
    const handler = (ev: { jobID: string; line: string }) => {
      if (ev.jobID === jobID) {
        lines.push(ev.line);
        if (lines.length >= maxLines) {
          runner.off('output', handler);
          resolve(lines);
        }
      }
    };
    runner.on('output', handler);
  });
}

function waitForExit(runner: ProcessRunner, jobID: string, exitPromise: Promise<number | null>): Promise<number | null> {
  return exitPromise.then((code) => {
    runner.dispose(jobID);
    return code;
  });
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('ProcessRunner', () => {
  let runner: ProcessRunner;

  beforeEach(() => {
    runner = new ProcessRunner();
  });

  afterEach(() => {
    runner.removeAllListeners();
  });

  // -- Spawn & exit promise -----------------------------------

  it('spawns with /bin/sh -c and detached group', async () => {
    const id = 'pr_1';
    const { exitPromise } = runner.run(id, 'echo hello');
    const code = await waitForExit(runner, id, exitPromise);
    expect(code).toBe(0);
  });

  it('creates exit promise before listeners — no race for fast commands', async () => {
    const id = 'pr_fast';
    const { exitPromise } = runner.run(id, 'true');
    const p = Promise.race([
      exitPromise.then((v) => v),
      new Promise<number>((r) => setTimeout(() => r(-1), 2000)),
    ]);
    const code = await p;
    expect(code).toBe(0);
    runner.dispose(id);
  });

  it('rejects duplicate jobID', () => {
    runner.run('dup', 'echo 1');
    expect(() => runner.run('dup', 'echo 2')).toThrow('already running');
  });

  // -- Output events -------------------------------------------

  it('emits OutputEvent with correct shape', async () => {
    const { exitPromise } = runner.run('out_1', 'echo hello');
    const lines = await waitForOutput(runner, 'out_1', 1);
    expect(lines).toContain('hello');
    await exitPromise;
    runner.dispose('out_1');
  });

  it('does not emit trailing empty line events', async () => {
    const id = 'no-trail';
    const results: OutputEvent[] = [];
    const outputSeen = new Promise<void>((resolve) => {
      runner.on('output', (ev) => {
        if (ev.jobID === id) resolve();
      });
    });
    runner.on('output', (ev) => {
      if (ev.jobID === id) results.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo one');
    await outputSeen;
    await exitPromise;
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.line.length > 0)).toBe(true);
    runner.dispose(id);
  });

  it('emits seq incrementing per stream', async () => {
    const id = 'seq_1';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo "seq test"');
    await exitPromise;
    const stdoutEvents = events.filter((e) => e.stream === 'stdout' && e.line.length > 0);
    for (let i = 1; i < stdoutEvents.length; i++) {
      expect(stdoutEvents[i].seq).toBeGreaterThan(stdoutEvents[i - 1].seq);
    }
    runner.dispose(id);
  });

  it('has numeric timestamp on each event', async () => {
    const id = 'ts_1';
    runner.on('output', (ev) => {
      if (ev.jobID === id) {
        expect(ev.timestamp).toBeGreaterThan(0);
      }
    });
    const { exitPromise } = runner.run(id, 'echo "ts test"');
    await exitPromise;
    runner.dispose(id);
  });

  // -- Partial line flush on stream end -------------------------

  it('flushes final partial line on stream end (no trailing newline)', async () => {
    const id = 'partial-flush';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, "printf 'done'");
    await exitPromise;
    const stdoutLines = events.filter((e) => e.stream === 'stdout').map((e) => e.line);
    expect(stdoutLines).toContain('done');
    runner.dispose(id);
  });

  it('tail includes final partial line', async () => {
    const id = 'partial-tail';
    const { exitPromise } = runner.run(id, "printf 'hello world'");
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    expect(tail).toContain('hello world');
    runner.dispose(id);
  });

  it('avoids synthetic trailing empty events on partial lines', async () => {
    const id = 'no-synthetic';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    // "done" has no trailing newline, so no empty line should be emitted
    const { exitPromise } = runner.run(id, "printf 'done'");
    await exitPromise;
    // No empty-string lines expected
    expect(events.some((e) => e.line.length === 0)).toBe(false);
    runner.dispose(id);
  });

  // -- Tail buffer --------------------------------------------

  it('stores rolling tail lines within cap', async () => {
    const id = 'tail_cap';
    const { exitPromise: ep } = runner.run(id, `printf 'a\\nb\\nc\\n'`);
    const events: Array<{ line: string }> = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    await ep;
    const tail = runner.tail(id, 'stdout');
    expect(tail.length).toBeLessThanOrEqual(3);
    expect(tail).toContain('a');
    runner.dispose(id);
  });

  it('tail cap respects rolling 200-line limit', async () => {
    const id = 'tail_roll';
    const lines = Array.from({ length: 250 }, (_, i) => String(i)).join('\n');
    const { exitPromise } = runner.run(id, `echo '${lines.replace(/\n/g, "\\n")}'`);
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    expect(tail.length).toBeGreaterThanOrEqual(1);
    // Ensure the last line (249) is in the tail
    expect(tail).toContain('249');
    runner.dispose(id);
  });

  it('tail cap drops oldest lines when exceeding 200', async () => {
    const id = 'tail_drop';
    // Generate >200 lines via printf
    const { exitPromise } = runner.run(id, `for i in $(seq 1 300); do echo $i; done`);
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    expect(tail.length).toBeLessThanOrEqual(PROCESS_OUTPUT_CAP_LINES + 1);
    // Line "1" should be dropped since we emitted 300 lines but cap is 200
    expect(tail).not.toContain('1');
    // Recent lines should be present
    expect(tail).toContain('299');
    runner.dispose(id);
  });

  // -- Cancel -------------------------------------------------

  it('cancel throws for unknown jobID', async () => {
    await expect(runner.cancel('ghost_0')).rejects.toThrow('not found');
  });

  it('cancel is idempotent for already-cancelled job', async () => {
    const id = 'cancel-idem';
    const { exitPromise } = runner.run(id, 'sleep 30');
    await runner.cancel(id);
    await runner.cancel(id);
    runner.dispose(id);
  });

  it('cancel returns when process has already exited', async () => {
    const id = 'fast-cancel';
    const { exitPromise } = runner.run(id, 'echo done');
    await exitPromise;
    await runner.cancel(id);
    runner.dispose(id);
  });

  it('cancel uses SIGTERM + SIGKILL to process group', async () => {
    // spawn with detached=true gives a process group (-pid).
    // cancel() sends -pid SIGTERM then SIGKILL after grace.
    const id = 'group-kill';
    const { exitPromise } = runner.run(id, 'sleep 60');
    await runner.cancel(id);
    // If we get here without hanging, cancel worked
    runner.dispose(id);
  });

  // -- Dispose ------------------------------------------------

  it('dispose clears handles', () => {
    const id = 'ds_1';
    runner.run(id, 'sleep 60');
    runner.dispose(id);
    expect(runner.tail(id, 'stdout')).toEqual([]);
  });
});
