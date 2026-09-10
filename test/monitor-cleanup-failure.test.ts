import { EventEmitter } from 'node:events';
import { get as httpGet } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../src/index.js';
import { readBridgeConfig } from '../src/bridge/server.js';

const seam = vi.hoisted(() => ({ runner: undefined as any }));
vi.mock('../src/runner/process-runner.js', () => ({ ProcessRunner: class { constructor() { return seam.runner; } } }));
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const context = () => ({ sessionID: 'owner', messageID: 'message', agent: 'operator', directory: '/fixture', worktree: '/fixture', abort: new AbortController().signal, metadata: vi.fn(), ask: vi.fn() });
afterEach(() => { seam.runner = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('joins independent cleanup and reports cancellation failure without waiting forever for the failed child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-cleanup-error-'));
  vi.stubEnv('XDG_RUNTIME_DIR', root); vi.stubEnv('OPENCODE_MONITOR_BRIDGE_CONFIG', join(root, 'bridge', 'config.json')); vi.stubEnv('OPENCODE_MONITOR_DEBUG', '0');
  const failedExit = deferred<number | null>(), goodExit = deferred<number | null>();
  const goodCancel = deferred(), promptGate = deferred(), promptEntered = deferred();
  const cleanupFailure = new Error('ordinary injected cancellation failure');
  const ids: string[] = [], cancelled: string[] = [], disposed: string[] = [];
  seam.runner = Object.assign(new EventEmitter(), {
    run: (id: string) => { ids.push(id); return { jobID: id, exitPromise: ids.length === 1 ? failedExit.promise : goodExit.promise }; },
    cancel: async (id: string) => { cancelled.push(id); if (id === ids[0]) throw cleanupFailure; await goodCancel.promise; },
    tail: () => [], dispose: (id: string) => { disposed.push(id); },
  });
  const promptAsync = vi.fn(async () => { promptEntered.resolve(); await promptGate.promise; return {}; });
  const hooks = await server({ directory: root, worktree: root, client: { session: { promptAsync } } });
  let outcome: { kind: string; error?: unknown } | undefined;
  let closing: Promise<void> | undefined;
  try {
    await hooks.tool.opencode_monitor_background.execute({ command: 'ordinary failed cleanup fixture' }, context());
    await hooks.tool.opencode_monitor_background.execute({ command: 'ordinary held cleanup fixture' }, context());
    expect(ids).toHaveLength(2);
    await hooks.tool.opencode_monitor_loop.execute({ raw: '10s independent held delivery' }, context());
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'owner' } } });
    await promptEntered.promise;
    const bridge = await readBridgeConfig();
    closing = hooks.dispose().then(() => { outcome = { kind: 'resolved' }; }, (error: unknown) => { outcome = { kind: 'rejected', error }; });
    await vi.waitFor(() => expect(cancelled.slice().sort()).toEqual(ids.slice().sort()));
    await delay(20); expect(outcome).toBeUndefined();
    goodExit.resolve(null); goodCancel.resolve();
    await delay(20); expect(outcome).toBeUndefined(); // started prompt still owned
    promptGate.resolve();
    await vi.waitFor(() => expect(outcome?.kind).toBe('rejected'), { timeout: 700 });
    expect(disposed).toContain(ids[1]);
    expect(disposed).not.toContain(ids[0]); // failed child's physical exit remains unresolved
    const errors = (value: any): unknown[] => [value, ...(Array.isArray(value?.errors) ? value.errors.flatMap(errors) : [])];
    expect(errors(outcome?.error)).toContain(cleanupFailure);
    const connection = await new Promise<string>((resolve) => {
      const request = httpGet(bridge.url + '/health', { agent: false }, response => { response.resume(); response.once('end', () => resolve('still-open')); });
      request.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
    });
    expect(connection).toBe('ECONNREFUSED');
    await expect(hooks.tool.opencode_monitor_background.execute({ command: 'must not start' }, context())).rejects.toThrow(/disposed|closed|closing/i);
    expect(ids).toHaveLength(2); expect(promptAsync).toHaveBeenCalledTimes(1);
  } finally {
    failedExit.resolve(null); goodExit.resolve(null); goodCancel.resolve(); promptGate.resolve();
    await closing;
    await hooks.dispose().catch(() => {});
  }
});
