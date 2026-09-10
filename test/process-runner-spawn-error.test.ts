import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessRunner } from '../src/runner/process-runner.js';

const seam = vi.hoisted(() => ({ child: undefined as any }));
vi.mock('child_process', async (original) => {
  const real = await original<typeof import('child_process')>();
  return { ...real, spawn: () => seam.child };
});
afterEach(() => { seam.child = undefined; vi.restoreAllMocks(); });

it('captures an asynchronous spawn error as the owned exit failure without an unhandled child event', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  seam.child = child;
  const runner = new ProcessRunner();
  const handle = runner.run('injected-spawn-error', 'ordinary fake command');
  const outcome = handle.exitPromise.then(
    (code) => ({ type: 'closed', code }),
    (error) => ({ type: 'failed', error }),
  );
  const failure = Object.assign(new Error('spawn /bin/sh EAGAIN (injected fixture)'), { code: 'EAGAIN' });
  let unhandled: unknown;
  try {
    await Promise.resolve(); // ChildProcess reports startup failure after run() has returned.
    try { child.emit('error', failure); } catch (error) { unhandled = error; }
    child.stdout.end(); child.stderr.end(); child.emit('close', null, null);
    expect(unhandled).toBeUndefined();
    expect(await outcome).toEqual({ type: 'failed', error: failure });
  } finally {
    child.emit('close', null, null);
    await outcome;
    runner.dispose('injected-spawn-error');
  }
  expect(runner.tail('injected-spawn-error', 'stdout')).toEqual([]);
});
