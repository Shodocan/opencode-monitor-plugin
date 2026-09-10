import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRunner } from '../src/runner/process-runner.js';
import { CANCEL_SIGKILL_TIMEOUT_MS } from '../src/limits.js';

const seam = vi.hoisted(() => ({ spawn: undefined as undefined | ((...args: any[]) => any) }));
vi.mock('child_process', async (original) => {
  const real = await original<typeof import('child_process')>();
  return { ...real, spawn: (...args: any[]) => seam.spawn ? seam.spawn(...args) : (real.spawn as any)(...args) };
});
afterEach(() => { seam.spawn = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function turns() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  seam.spawn = () => child;
  return child;
}
function close(child: ReturnType<typeof fakeChild>) { child.stdout.end(); child.stderr.end(); child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

describe('captured process cancellation ownership', () => {
  it('joins concurrent cancellation until the captured process close', async () => {
    vi.useFakeTimers(); const child = fakeChild(); const runner = new ProcessRunner(); runner.run('held', 'ordinary fixture');
    let oneDone = false, twoDone = false;
    const one = runner.cancel('held').then(() => { oneDone = true; });
    const two = runner.cancel('held').then(() => { twoDone = true; });
    try { await turns(); expect(oneDone).toBe(false); expect(twoDone).toBe(false); }
    finally { close(child); await Promise.all([one, two]); runner.dispose('held'); }
    expect(child.kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('clears the grace timer after an early physical close', async () => {
    vi.useFakeTimers(); const child = fakeChild(); const runner = new ProcessRunner(); runner.run('early', 'ordinary fixture');
    const cancelled = runner.cancel('early'); close(child); await cancelled; runner.dispose('early');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reaps its remaining group descendant when the group leader exits before close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'monitor-owned-descendant-')); vi.stubEnv('XDG_RUNTIME_DIR', root); vi.stubEnv('OPENCODE_MONITOR_DEBUG', '0');
    const ready = join(root, 'ready.json'), childReady = join(root, 'child-ready'), childFile = join(root, 'child.cjs'), parentFile = join(root, 'parent.cjs');
    await writeFile(childFile, `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(childReady)},'ready');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000);`);
    await writeFile(parentFile, `const fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,[${JSON.stringify(childFile)}],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>process.exit(0));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(childReady)})){clearInterval(t);fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,child:child.pid}));}},5);setInterval(()=>{},1000);`);
    const runner = new ProcessRunner(); const handle = runner.run('owned', `exec ${quote(process.execPath)} ${quote(parentFile)}`);
    let ids: { parent: number; child: number } | undefined; let cancelled: Promise<void> | undefined;
    try {
      await vi.waitFor(async () => { ids = JSON.parse(await readFile(ready, 'utf8')); expect(ids?.child).toBeGreaterThan(1); }, { timeout: 3000 });
      cancelled = runner.cancel('owned');
      const result = await Promise.race([cancelled.then(() => 'closed'), realDelay(CANCEL_SIGKILL_TIMEOUT_MS + 700).then(() => 'still-open')]);
      expect(result).toBe('closed');
      const stat = await readFile(`/proc/${ids!.child}/stat`, 'utf8').catch(() => 'missing');
      expect(stat === 'missing' || /\) [ZX] /.test(stat)).toBe(true);
    } finally {
      if (ids) { try { process.kill(-ids.parent, 'SIGKILL'); } catch {} }
      else { await runner.cancel('owned').catch(() => {}); }
      await handle.exitPromise; await cancelled; runner.dispose('owned');
    }
  }, 12000);
});
