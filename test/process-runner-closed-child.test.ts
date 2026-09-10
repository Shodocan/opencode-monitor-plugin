import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessRunner } from '../src/runner/process-runner.js';
const seam = vi.hoisted(() => ({ child: undefined as any }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: () => seam.child }));
afterEach(() => { seam.child = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

it('joins a physically closed captured child without signalling its stale PID', async () => {
  vi.useFakeTimers();
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const child = Object.assign(new EventEmitter(), { pid: 43210, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  seam.child = child;
  const runner = new ProcessRunner(); const handle = runner.run('closed', 'ordinary fake command');
  try {
    child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null); child.emit('close', 0, null);
    expect(await handle.exitPromise).toBe(0);
    await runner.cancel('closed');
    expect(signal).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { runner.dispose('closed'); }
});
