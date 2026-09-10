import { EventEmitter } from 'node:events';
import { get as httpGet } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMonitorPlugin, server } from '../src/index.js';
import { JobRegistry } from '../src/registry/job-registry.js';
import { ProcessRunner } from '../src/runner/process-runner.js';
import { readBridgeConfig } from '../src/bridge/server.js';
import * as statusStore from '../src/status-store.js';
import type { OutputEvent, OutputStream } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function turns() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const context = (sessionID = 'owner') => ({ sessionID, invocationOrigin: 'user' as const, registerSlashCommand: vi.fn() });
const toolContext = (sessionID = 'owner') => ({ sessionID, messageID: 'message', agent: 'operator', directory: '/fixture', worktree: '/fixture', abort: new AbortController().signal, metadata: vi.fn(), ask: vi.fn() });
// The compatibility fallback exposes the old incomplete shutdown behavior as
// behavioral RED. The public-hook contract is asserted separately below.
const dispose = (value: any): Promise<void> => Promise.resolve(value.dispose?.() ?? value.__stop?.());
const releaseGates: Array<() => void> = [];
const originalWriteStatus = statusStore.writeMonitorStatus;
const cleanup: Array<() => unknown | Promise<unknown>> = [];
let root: string;

class HeldRunner extends EventEmitter {
  jobs = new Map<string, ReturnType<typeof deferred<number | null>>>();
  cancellations = new Map<string, ReturnType<typeof deferred>>();
  cancelled: string[] = [];
  disposed: string[] = [];
  run(jobID: string) { const exit = deferred<number | null>(); this.jobs.set(jobID, exit); return { jobID, exitPromise: exit.promise }; }
  async cancel(jobID: string) { this.cancelled.push(jobID); let gate = this.cancellations.get(jobID); if (!gate) { gate = deferred(); this.cancellations.set(jobID, gate); } await gate.promise; }
  tail(_id: string, stream: OutputStream) { return stream === 'stdout' ? ['ordinary fixture output'] : []; }
  dispose(jobID: string) { this.disposed.push(jobID); }
  release(jobID: string) { this.jobs.get(jobID)?.resolve(null); this.cancellations.get(jobID)?.resolve(); }
  releaseAll() { for (const id of this.jobs.keys()) this.release(id); }
  output(jobID: string, line = 'MATCH fixture', seq = 1) { this.emit('output', { jobID, seq, stream: 'stdout', line, timestamp: Date.now() } satisfies OutputEvent); }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'monitor-disposal-test-'));
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  vi.stubEnv('OPENCODE_MONITOR_BRIDGE_CONFIG', join(root, 'bridge', 'config.json'));
  vi.stubEnv('OPENCODE_MONITOR_DEBUG', '0');
  vi.spyOn(statusStore, 'writeMonitorStatus').mockResolvedValue(undefined);
  vi.spyOn(statusStore, 'writeMonitorTail').mockResolvedValue(undefined);
  vi.spyOn(statusStore, 'removeMonitorTail').mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await turns();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function helper(extra: Record<string, unknown> = {}) {
  const runner = new HeldRunner(); const registry = new JobRegistry('fixture'); const notify = vi.fn(async () => {});
  const plugin = createMonitorPlugin({ runner, registry, notify, health: async () => {}, statusScope: root, ...extra });
  cleanup.push(async () => { runner.releaseAll(); await turns(); await dispose(plugin); });
  return { runner, registry, notify, plugin };
}
async function hooks(promptAsync = vi.fn(async () => ({})), directory = root) {
  const result = await server({ directory, worktree: directory, client: { session: { promptAsync } } });
  cleanup.push(() => result.__stop());
  await result.event({ event: { type: 'session.status', properties: { sessionID: 'owner', status: { type: 'idle' } } } });
  return { result, promptAsync };
}

describe('owned monitor lifecycle disposal', () => {
  it('exposes the native dispose hook and keeps __stop as the same lifecycle alias', async () => {
    const { result } = await hooks();
    expect(typeof result.dispose).toBe('function');
    expect(result.__stop).toBe(result.dispose);
    await Promise.all([result.dispose(), result.__stop(), result.dispose()]);
  });

  it('fences a producer resuming from health admission after disposal', async () => {
    const health = deferred(); const entered = deferred();
    const f = helper({ health: async () => { entered.resolve(); await health.promise; } });
    const started = f.plugin.handlers.background('ordinary harmless fixture', context());
    const outcome = started.then(value => ({ value }), error => ({ error: String(error) }));
    await entered.promise;
    const closing = dispose(f.plugin);
    health.resolve(); await closing;
    expect(await outcome).toMatchObject({ error: expect.stringMatching(/disposed|closing|closed/i) });
    expect(f.runner.jobs.size).toBe(0); expect(f.registry.activeCount).toBe(0);
  });

  it('awaits every owned background and monitor close before resolving concurrent disposal', async () => {
    vi.useFakeTimers(); const f = helper();
    await f.plugin.handlers.background('ordinary fixture', context());
    await f.plugin.handlers.monitor('--regex MATCH --before 0 --after 1 --debounce 1 -- ordinary fixture', context());
    f.runner.output('bg_1'); f.runner.output('mon_2');
    let firstDone = false, secondDone = false;
    const first = dispose(f.plugin).then(() => { firstDone = true; });
    const second = dispose(f.plugin).then(() => { secondDone = true; });
    await turns();
    expect(f.runner.cancelled.slice().sort()).toEqual(['bg_1', 'mon_2']);
    expect(firstDone).toBe(false); expect(secondDone).toBe(false);
    f.runner.release('bg_1'); await turns(); expect(firstDone).toBe(false);
    f.runner.release('mon_2'); await Promise.all([first, second]);
    expect(f.registry.activeCount).toBe(0);
    expect(f.registry.list().map(x => x.status)).toEqual(['cancelled', 'cancelled']);
    expect(f.runner.listenerCount('output')).toBe(0);
    const calls = f.notify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.notify).toHaveBeenCalledTimes(calls); expect(calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins held tail I/O and detaches output producers before reporting disposed', async () => {
    vi.useFakeTimers(); const gate = deferred(); const entered = deferred();
    vi.mocked(statusStore.writeMonitorTail).mockImplementation(async () => { entered.resolve(); await gate.promise; });
    releaseGates.push(() => gate.resolve());
    const f = helper(); await f.plugin.handlers.background('ordinary fixture', context());
    f.runner.output('bg_1'); await vi.advanceTimersByTimeAsync(1000); await entered.promise;
    let done = false; const closing = dispose(f.plugin).then(() => { done = true; });
    await turns(); f.runner.release('bg_1'); await turns();
    expect(done).toBe(false);
    gate.resolve(); await closing;
    const count = vi.mocked(statusStore.writeMonitorTail).mock.calls.length;
    f.runner.output('bg_1', 'late fixture event', 2); await vi.advanceTimersByTimeAsync(2000);
    expect(statusStore.writeMonitorTail).toHaveBeenCalledTimes(count);
    expect(f.runner.listenerCount('output')).toBe(0);
  });

  it('awaits an already-started synthetic delivery before closing the public bridge', async () => {
    vi.useFakeTimers(); const gate = deferred(); const entered = deferred();
    const prompt = vi.fn(async () => { entered.resolve(); await gate.promise; return {}; });
    releaseGates.push(() => gate.resolve());
    const { result } = await hooks(prompt);
    await result.tool.opencode_monitor_loop.execute({ raw: '10s one ordinary fixture prompt' }, toolContext());
    await result.event({ event: { type: 'session.idle', properties: { sessionID: 'owner' } } });
    await entered.promise;
    let done = false; const closing = dispose(result).then(() => { done = true; });
    await turns(); await realDelay(20); expect(done).toBe(false);
    gate.resolve(); await closing;
    const delivered = prompt.mock.calls.length;
    await vi.advanceTimersByTimeAsync(35_000);
    expect(prompt).toHaveBeenCalledTimes(delivered); expect(delivered).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits pending public status writes instead of leaving writes after disposal', async () => {
    const gate = deferred(); const entered = deferred();
    vi.mocked(statusStore.writeMonitorStatus).mockImplementation(async () => { entered.resolve(); await gate.promise; });
    releaseGates.push(() => gate.resolve()); const { result } = await hooks(); await result.event({ event: { type: 'session.idle', properties: { sessionID: 'owner' } } });
    await entered.promise;
    let done = false; const closing = dispose(result).then(() => { done = true; });
    await turns(); await realDelay(20); expect(done).toBe(false);
    gate.resolve(); await closing;
    const count = vi.mocked(statusStore.writeMonitorStatus).mock.calls.length; await turns();
    expect(statusStore.writeMonitorStatus).toHaveBeenCalledTimes(count);
  });

  it('cancels schedules, queued loop output and idle fallback timers while preserving another instance', async () => {
    vi.useFakeTimers();
    const one = await hooks(undefined, join(root, 'one'));
    await one.result.event({ event: { type: 'session.status', properties: { sessionID: 'owner', status: { type: 'busy' } } } });
    await one.result.tool.opencode_monitor_loop.execute({ raw: '10s obsolete loop' }, toolContext());
    await one.result.tool.opencode_monitor_schedule.execute({ raw: 'in 3s obsolete schedule' }, toolContext());
    const two = await hooks(undefined, join(root, 'two'));
    const currentConfig = await readFile(process.env.OPENCODE_MONITOR_BRIDGE_CONFIG!, 'utf8');
    await dispose(one.result);
    await expect(one.result.tool.opencode_monitor_schedule.execute({ raw: 'in 1s forbidden after disposal' }, toolContext())).rejects.toThrow(/disposed|closing|closed/i);
    await one.result.event({ event: { type: 'session.idle', properties: { sessionID: 'owner' } } });
    await two.result.tool.opencode_monitor_schedule.execute({ raw: 'in 1s other instance remains usable' }, toolContext());
    await vi.advanceTimersByTimeAsync(31_000);
    expect(one.promptAsync).not.toHaveBeenCalled(); expect(two.promptAsync).toHaveBeenCalledTimes(1);
    expect(await readFile(process.env.OPENCODE_MONITOR_BRIDGE_CONFIG!, 'utf8')).toBe(currentConfig);
    const bridge = await readBridgeConfig();
    const healthStatus = await new Promise<number>((resolve, reject) => {
      const request = httpGet(bridge.url + '/health', { agent: false }, (response) => {
        response.on('error', reject);
        response.on('end', () => resolve(response.statusCode ?? 0));
        response.resume();
      });
      request.on('error', reject);
    });
    expect(healthStatus).toBe(200);
    await dispose(two.result); expect(vi.getTimerCount()).toBe(0);
  });

  it('retains failed monitor ownership until its still-live process closes', async () => {
    vi.useFakeTimers(); const notify = vi.fn(async () => { throw new Error('ordinary delivery failure'); });
    const f = helper({ notify });
    await f.plugin.handlers.monitor('--regex MATCH --before 0 --after 0 --debounce 1 -- ordinary fixture', context());
    f.runner.output('mon_1'); await vi.advanceTimersByTimeAsync(1000); await turns();
    expect(f.registry.get('mon_1')?.status).toBe('failed');
    let done = false; const closing = dispose(f.plugin).then(() => { done = true; }); await turns();
    expect(f.runner.cancelled).toEqual(['mon_1']); expect(done).toBe(false);
    f.runner.release('mon_1'); await closing;
    expect(f.runner.listenerCount('output')).toBe(0);
    const count = notify.mock.calls.length; await vi.advanceTimersByTimeAsync(30000); expect(notify).toHaveBeenCalledTimes(count);
  });

  it('serializes a delayed earlier status write before the final disposed snapshot', async () => {
    const gate = deferred(), firstCommitted = deferred(); let first = true;
    releaseGates.push(() => gate.resolve());
    vi.mocked(statusStore.writeMonitorStatus).mockImplementation(async (scope, snapshot) => {
      if (first) { first = false; await gate.promise; await originalWriteStatus(scope, snapshot); firstCommitted.resolve(); return; }
      await originalWriteStatus(scope, snapshot);
    });
    const { result, promptAsync } = await hooks();
    await result.tool.opencode_monitor_background.execute({ command: "printf 'ordered-status-fixture\\n'" }, toolContext());
    await result.event({ event: { type: 'session.idle', properties: { sessionID: 'owner' } } });
    await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1), { timeout: 3000 });
    gate.resolve(); await firstCommitted.promise; await dispose(result);
    expect(statusStore.readMonitorStatus(root)).toMatchObject({ completedCount: 1, jobs: [], bridgeUp: false, scheduledPending: 0 });
  });

  it('preserves a real harmless background result and one terminal state with one delivery', async () => {
    vi.mocked(statusStore.writeMonitorStatus).mockImplementation(originalWriteStatus);
    const { result, promptAsync } = await hooks();
    const nonce = 'monitor-disposal-positive-control';
    const response = await result.tool.opencode_monitor_background.execute({ command: `printf '${nonce}\\n'` }, toolContext());
    expect(response).toBe('started bg_1');
    await vi.waitFor(() => expect(promptAsync).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ path: { id: 'owner' }, body: { parts: [{ metadata: { opencodeMonitorJobID: 'bg_1' } }] } });
    expect(statusStore.writeMonitorStatus).toHaveBeenLastCalledWith(root, expect.objectContaining({ completedCount: 1 }));
    await vi.waitFor(() => expect(statusStore.readMonitorStatus(root).completedCount).toBe(1), { timeout: 3000 });
    await dispose(result); await new Promise(resolve => setTimeout(resolve, 50));
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(statusStore.readMonitorStatus(root).completedCount).toBe(1);
  });

  it('joins physical child close even when per-job cancellation already owns the runner cancel', async () => {
    const script = join(root, 'child.cjs'), ready = join(root, 'ready'), term = join(root, 'term'), release = join(root, 'release');
    await writeFile(script, `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(term)},'term');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0)}},5)});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
    const runner = new ProcessRunner(); const notify = vi.fn(async () => {});
    const plugin = createMonitorPlugin({ runner, notify, health: async () => {}, statusScope: root });
    await plugin.handlers.background(`exec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'`, context());
    let cancelled: Promise<unknown> | undefined;
    cleanup.push(async () => { await writeFile(release, 'release'); if (cancelled) await cancelled; else await runner.cancel('bg_1').catch(() => {}); await dispose(plugin); });
    await vi.waitFor(async () => expect(Number(await readFile(ready, 'utf8'))).toBeGreaterThan(1), { timeout: 3000 });
    const pid = Number(await readFile(ready, 'utf8'));
    cancelled = plugin.handlers.cancel('bg_1', context());
    await vi.waitFor(async () => expect(await readFile(term, 'utf8')).toBe('term'), { timeout: 1000 });
    let done = false; const closing = dispose(plugin).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(done).toBe(false); expect(() => process.kill(pid, 0)).not.toThrow();
    await writeFile(release, 'release'); await Promise.all([cancelled, closing]);
    expect(() => process.kill(pid, 0)).toThrow(); expect(notify).not.toHaveBeenCalled();
  });
});
