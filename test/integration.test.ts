import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoSubmitRequest, OutputEvent, OutputStream } from '../src/types.js';
import { BridgeServer, type AppendNotification } from '../src/bridge/server.js';
import { appendSubmitToSession, health as bridgeHealth } from '../src/delivery/notifier.js';
import { createMonitorPlugin } from '../src/index.js';
import type { PluginContext } from '../src/plugin-context.js';
import { PromptScheduler } from '../src/scheduler/prompt-scheduler.js';
import { IdleQueue } from '../src/bridge/idle-queue.js';
import { MAX_PENDING_GLOBAL } from '../src/limits.js';
import { formatDelivery } from '../src/delivery/delivery-formatter.js';

const servers: BridgeServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

class FakeRunner {
  outputHandlers = new Set<(event: OutputEvent) => void>();
  disposed: string[] = [];
  tails = new Map<string, Record<OutputStream, string[]>>();
  exits = new Map<string, (code: number | null) => void>();

  run(jobID: string): { jobID: string; exitPromise: Promise<number | null> } {
    const exitPromise = new Promise<number | null>((resolve) => this.exits.set(jobID, resolve));
    this.tails.set(jobID, { stdout: ['full output'], stderr: [] });
    return { jobID, exitPromise };
  }

  cancel(): Promise<void> { return Promise.resolve(); }
  tail(jobID: string, stream: OutputStream): string[] { return this.tails.get(jobID)?.[stream] ?? []; }
  dispose(jobID: string): void { this.disposed.push(jobID); }
  on(_event: 'output', handler: (event: OutputEvent) => void): void { this.outputHandlers.add(handler); }
  off(_event: 'output', handler: (event: OutputEvent) => void): void { this.outputHandlers.delete(handler); }
}

function userCtx(sessionID = 's1'): PluginContext {
  return { sessionID, invocationOrigin: 'user', registerSlashCommand: vi.fn() };
}

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-integration-'));
  return join(dir, 'bridge.json');
}

async function startBridge(delivered: AppendNotification[]): Promise<{ server: BridgeServer; configPath: string }> {
  const configPath = await tempConfigPath();
  const server = new BridgeServer({
    configPath,
    onAppend: (payload) => {
      delivered.push(payload);
      return true;
    },
  });
  servers.push(server);
  await server.start();
  return { server, configPath };
}

describe('opencode monitor plugin integration', () => {
  it('background completes while busy and sends full payload after idle', async () => {
    const delivered: AppendNotification[] = [];
    const { server, configPath } = await startBridge(delivered);
    server.setSessionStatus('s1', 'busy');
    const runner = new FakeRunner();
    const plugin = createMonitorPlugin({
      runner,
      health: () => bridgeHealth(configPath),
      notify: (request) => appendSubmitToSession(request, configPath),
    });

    await plugin.handlers.background('echo hi', userCtx('s1'));
    runner.exits.get('bg_1')?.(0);
    await vi.waitFor(() => expect(runner.disposed).toContain('bg_1'));
    expect(delivered).toEqual([]);

    server.setSessionStatus('s1', 'idle');
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].params.text).toContain('background bg_1 exited');
    expect(delivered[0].params.text).toContain('full output');
  });

  it('monitor match queues until idle and duplicate seqs are not resent', async () => {
    vi.useFakeTimers();
    const delivered: AppendNotification[] = [];
    const { server, configPath } = await startBridge(delivered);
    server.setSessionStatus('s1', 'busy');
    const runner = new FakeRunner();
    const plugin = createMonitorPlugin({
      runner,
      health: () => bridgeHealth(configPath),
      notify: (request) => appendSubmitToSession(request, configPath),
    });

    await plugin.handlers.monitor('--regex ERR --before 0 --after 0 --debounce 1 -- echo test', userCtx('s1'));
    for (const handler of runner.outputHandlers) {
      handler({ jobID: 'mon_1', seq: 1, stream: 'stdout', line: 'ERR one', timestamp: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toEqual([]);

    server.setSessionStatus('s1', 'idle');
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    for (const handler of runner.outputHandlers) {
      handler({ jobID: 'mon_1', seq: 1, stream: 'stdout', line: 'ERR one again', timestamp: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toHaveLength(1);
  });

  it('coalesces loop backlog into one idle delivery with tick count metadata', async () => {
    const delivered: AppendNotification[] = [];
    const { server, configPath } = await startBridge(delivered);
    server.setSessionStatus('s1', 'busy');

    for (const text of ['tick-1', 'tick-2', 'tick-3']) {
      await appendSubmitToSession({ sessionID: 's1', jobID: 'loop_1', kind: 'loop', text, submit: true }, configPath);
    }
    expect(delivered).toEqual([]);

    server.setSessionStatus('s1', 'idle');
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].params.text).toContain('tick-3');
    expect(delivered[0].params.text).toContain('coalesced 3 loop ticks');
  });

  it('scheduled prompt fires once and waits for idle', async () => {
    const delivered: AppendNotification[] = [];
    const { server, configPath } = await startBridge(delivered);
    server.setSessionStatus('s1', 'busy');
    const scheduler = new PromptScheduler({ delivery: (request) => appendSubmitToSession(request, configPath) });

    scheduler.scheduleOnce({ jobID: 'sched_1', sessionID: 's1', runAt: new Date(Date.now() + 10), prompt: 'later' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(delivered).toEqual([]);

    server.setSessionStatus('s1', 'idle');
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(delivered).toHaveLength(1);
    scheduler.destroy();
  });

  it('cross-session jobs and cancel are isolated', async () => {
    const runner = new FakeRunner();
    const plugin = createMonitorPlugin({ runner, health: async () => undefined });

    await plugin.handlers.background('echo one', userCtx('s1'));
    await plugin.handlers.background('echo two', userCtx('s2'));

    await expect(plugin.handlers.cancel('bg_1', userCtx('s2'))).rejects.toThrow(/another session/);
    const s1Jobs = await plugin.handlers.jobs('', userCtx('s1'));
    expect(s1Jobs).toContain('bg_1');
    expect(s1Jobs).not.toContain('bg_2');
  });

  it('queue overflow increments dropped counter', () => {
    const q = new IdleQueue('busy', () => true);
    for (let i = 0; i < MAX_PENDING_GLOBAL + 2; i++) {
      q.enqueue({ sessionID: 's1', jobID: `bg_${i}`, kind: 'bg', text: 'x', submit: true });
    }
    expect(q.dropped).toBe(2);
  });

  it('bridge health/auth rejection paths stay bounded and secret-free', async () => {
    const delivered: AppendNotification[] = [];
    const { server, configPath } = await startBridge(delivered);
    const configHealth = await bridgeHealth(configPath);
    expect(configHealth).toEqual({ ok: true });

    const config = await import('../src/bridge/server.js').then((m) => m.readBridgeConfig(configPath));
    const response = await fetch(`${config.url}/notify/append-submit`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(config.token);
    server.setSessionStatus('s1', 'idle');
  });

  it('redacts output secrets inside nonce-framed delivery text', () => {
    const formatted = formatDelivery('TOKEN=abc123\nhello', { nonce: 'abcdabcdabcdabcdabcdabcdabcdabcd' });
    expect(formatted.text).toContain('abcdabcdabcdabcdabcdabcdabcdabcd');
    expect(formatted.text).toContain('monitor triggered.');
    expect(formatted.text).toContain('TOKEN=****');
    expect(formatted.text).not.toContain('abc123');
  });
});
