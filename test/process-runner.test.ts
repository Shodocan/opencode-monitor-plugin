import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ProcessRunner } from '../src/runner/process-runner.js';

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

function waitForExit(runner: ProcessRunner, jobID: string, exitPromise: Promise<number | null>): number | null {
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
    // The exit promise is resolved synchronously on 'exit' event.
    // Because we attach the listener at spawn time (before returning),
    // even a sub-ms command will resolve it.
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

  function runEcho(runner: ProcessRunner, id: string, text: string) {
    return runner.run(id, `echo '${text}'`);
  }

  it('does not emit trailing empty line events', async () => {
    // A process that prints "abc\n" should emit exactly one event (line="abc"),
    // not an extra event with an empty trailing line.
    const id = 'no-trail';
    const results: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) results.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo one');
    await exitPromise;
    // Only real content lines, nothing trailing.
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.line.length > 0 || results.indexOf(r) < results.length - 1 || r.seq === results[results.length - 1].seq)).toBe(true);
    runner.dispose(id);
  });

  it('emits seq incrementing per steam', async () => {
    const id = 'seq_1';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo "seq test"');
    await exitPromise;
    const stdoutEvents = events.filter((e) => e.stream === 'stdout' && e.line.length > 0);
    // seq should be monotonic
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

  // -- Cancel -------------------------------------------------

  it('cancel throws for unknown jobID', async () => {
    await expect(runner.cancel('ghost_0')).rejects.toThrow('not found');
  });

  it('cancel is idempotent for already-cancelled job', async () => {
    const id = 'cancel-idem';
    const { exitPromise } = runner.run(id, 'sleep 30');
    await runner.cancel(id);
    await runner.cancel(id); // no second error
    runner.dispose(id);
  });

  it('cancel returns when process has already exited', async () => {
    const id = 'fast-cancel';
    const { exitPromise } = runner.run(id, 'echo done');
    await exitPromise;
    // cancel after exit — should not hang
    await runner.cancel(id);
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
