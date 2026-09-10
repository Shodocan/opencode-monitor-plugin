import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessRunner } from '../src/runner/process-runner.js';
const seam = vi.hoisted(() => ({ child: undefined as any }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: () => seam.child }));
afterEach(() => { seam.child = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

it('does not mistake an established child error for physical close or completed cancellation', async () => {
  vi.useFakeTimers();
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const child = Object.assign(new EventEmitter(), { pid: 43210, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  seam.child = child;
  const runner = new ProcessRunner(); const handle = runner.run('established', 'ordinary fake command');
  let exited = false, cancelled = false;
  const exit = handle.exitPromise.then(() => { exited = true; }, () => { exited = true; });
  let cancellation: Promise<void> | undefined;
  try {
    expect(() => child.emit('error', new Error('ordinary injected signal error'))).not.toThrow();
    cancellation = runner.cancel('established').then(() => { cancelled = true; }, () => { cancelled = true; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(exited).toBe(false); expect(cancelled).toBe(false);
    child.stdout.end(); child.stderr.end(); child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM');
    await Promise.all([exit, cancellation]);
    expect(exited).toBe(true); expect(cancelled).toBe(true);
    expect(signal).toHaveBeenCalledWith(-43210, 'SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    child.emit('close', null, 'SIGTERM'); await Promise.all([exit, cancellation]); runner.dispose('established');
  }
});
