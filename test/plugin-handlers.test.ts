import { describe, expect, it, vi } from 'vitest';
import type { AutoSubmitRequest, OutputEvent, OutputStream } from '../src/types.js';
import type { PluginContext } from '../src/plugin-context.js';
import { createMonitorPlugin, server } from '../src/index.js';

class FakeRunner {
  outputHandlers = new Set<(event: OutputEvent) => void>();
  cancelled: string[] = [];
  disposed: string[] = [];
  tails = new Map<string, Record<OutputStream, string[]>>();
  exits = new Map<string, (code: number | null) => void>();
  throwOnRun = false;

  run(jobID: string): { jobID: string; exitPromise: Promise<number | null> } {
    if (this.throwOnRun) throw new Error('spawn failed');
    const exitPromise = new Promise<number | null>((resolve) => this.exits.set(jobID, resolve));
    this.tails.set(jobID, { stdout: ['ok'], stderr: [] });
    return { jobID, exitPromise };
  }

  cancel(jobID: string): Promise<void> {
    this.cancelled.push(jobID);
    return Promise.resolve();
  }

  tail(jobID: string, stream: OutputStream): string[] {
    return this.tails.get(jobID)?.[stream] ?? [];
  }

  dispose(jobID: string): void {
    this.disposed.push(jobID);
  }

  on(_event: 'output', handler: (event: OutputEvent) => void): void {
    this.outputHandlers.add(handler);
  }

  off(_event: 'output', handler: (event: OutputEvent) => void): void {
    this.outputHandlers.delete(handler);
  }
}

class FakeScheduler {
  loops: unknown[] = [];
  schedules: unknown[] = [];
  cancelled: string[] = [];
  throwOnLoop = false;
  throwOnSchedule = false;

  scheduleLoop(cfg: unknown): void {
    if (this.throwOnLoop) throw new Error('loop schedule failed');
    this.loops.push(cfg);
  }
  scheduleOnce(cfg: unknown): void {
    if (this.throwOnSchedule) throw new Error('schedule failed');
    this.schedules.push(cfg);
  }
  cancel(jobID: string): boolean { this.cancelled.push(jobID); return true; }
}

function userCtx(sessionID = 's1'): PluginContext {
  return { sessionID, invocationOrigin: 'user', registerSlashCommand: vi.fn() };
}

describe('plugin command handlers', () => {
  it('registers slash commands', () => {
    const registered = new Map<string, unknown>();
    createMonitorPlugin().registerCommands({
      registerSlashCommand: (name, handler) => registered.set(name, handler),
    });

    expect([...registered.keys()].sort()).toEqual(['background', 'cancel', 'jobs', 'loop', 'monitor', 'schedule']);
  });

  it('exports an opencode-compatible server plugin that registers command templates', async () => {
    const hooks = await server({});
    const config: { command?: Record<string, { template: string; description?: string }> } = {};

    await hooks.config(config);

    expect(Object.keys(config.command ?? {}).sort()).toEqual(['background', 'cancel', 'jobs', 'loop', 'monitor', 'schedule']);
    expect(config.command?.background.template).toContain('opencode_monitor_background');
    expect(hooks.tool).toHaveProperty('opencode_monitor_background');
    expect(hooks.tool).toHaveProperty('opencode_monitor_jobs');
    await hooks.__stop();
  });

  it('server hook tools can start background jobs', async () => {
    vi.useFakeTimers();
    const hooks = await server({});
    const abort = new AbortController();

    const result = await hooks.tool.opencode_monitor_background.execute(
      { command: 'printf ok' },
      {
        sessionID: 's1',
        messageID: 'm1',
        agent: 'operator',
        directory: process.cwd(),
        worktree: process.cwd(),
        abort: abort.signal,
        metadata: vi.fn(),
        ask: vi.fn(),
      },
    );

    expect(result).toContain('started bg_1');
    await vi.advanceTimersByTimeAsync(1500);
    await hooks.__stop();
    vi.useRealTimers();
  });

  it('server hook tracks session status events', async () => {
    const hooks = await server({});

    await expect(hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    })).resolves.toBeUndefined();
    await hooks.__stop();
  });

  it('server hook publishes append deliveries through the opencode client', async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => ({ data: true }));
    const hooks = await server({ client: { tui: { publish } }, directory: '/tmp/project' });

    await hooks.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    });
    await hooks.tool.opencode_monitor_background.execute(
      { command: 'printf ok' },
      {
        sessionID: 's1',
        messageID: 'm1',
        agent: 'operator',
        directory: process.cwd(),
        worktree: process.cwd(),
        abort: new AbortController().signal,
        metadata: vi.fn(),
        ask: vi.fn(),
      },
    );

    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish.mock.calls[0][0]).toMatchObject({
      query: { directory: '/tmp/project' },
      body: { type: 'tui.prompt.append', properties: { sessionID: 's1', submit: true } },
    });
    expect(publish.mock.calls[0][0].body.properties.text).toContain('ok');
    await hooks.__stop();
    vi.useRealTimers();
  });

  it('rejects missing session ID and non-user origins', async () => {
    const plugin = createMonitorPlugin({ health: async () => undefined });

    await expect(plugin.handlers.jobs('', { invocationOrigin: 'user', registerSlashCommand: vi.fn() }))
      .rejects.toThrow(/sessionID is required/);
    await expect(plugin.handlers.jobs('', { sessionID: 's1', invocationOrigin: 'model', registerSlashCommand: vi.fn() }))
      .rejects.toThrow(/direct user/);
  });

  it('rejects new jobs when the bridge is unavailable and leaves no active job', async () => {
    const plugin = createMonitorPlugin({ health: async () => { throw new Error('bridge down'); } });

    await expect(plugin.handlers.loop('10s wake up', userCtx('s1'))).rejects.toThrow('bridge down');

    const jobs = await plugin.handlers.jobs('', userCtx('s1'));
    expect(jobs).not.toContain('loop_1');
  });

  it('starts loop and schedule jobs through the scheduler', async () => {
    const scheduler = new FakeScheduler();
    const plugin = createMonitorPlugin({ health: async () => undefined, scheduler });

    await expect(plugin.handlers.loop('10s ping', userCtx('s1'))).resolves.toContain('loop_1');
    await expect(plugin.handlers.schedule('in 1s later', userCtx('s1'))).resolves.toContain('sched_2');

    expect(scheduler.loops).toHaveLength(1);
    expect(scheduler.schedules).toHaveLength(1);
    expect(scheduler.schedules[0]).toMatchObject({ jobID: 'sched_2', sessionID: 's1', prompt: 'later' });
  });

  it('scheduler startup failure does not leave an active runtime', async () => {
    const scheduler = new FakeScheduler();
    scheduler.throwOnLoop = true;
    const plugin = createMonitorPlugin({ health: async () => undefined, scheduler });

    await expect(plugin.handlers.loop('10s ping', userCtx('s1'))).rejects.toThrow('loop schedule failed');

    const jobs = await plugin.handlers.jobs('', userCtx('s1'));
    expect(jobs).not.toContain('loop_1');
  });

  it('/jobs is scoped by session', async () => {
    const runner = new FakeRunner();
    const plugin = createMonitorPlugin({ health: async () => undefined, runner });

    await plugin.handlers.background('echo one', userCtx('s1'));
    await plugin.handlers.background('echo two', userCtx('s2'));

    const s1Jobs = await plugin.handlers.jobs('', userCtx('s1'));
    expect(s1Jobs).toContain('bg_1');
    expect(s1Jobs).not.toContain('bg_2');
  });

  it('/cancel rejects cross-session jobs', async () => {
    const runner = new FakeRunner();
    const plugin = createMonitorPlugin({ health: async () => undefined, runner });

    await plugin.handlers.background('echo one', userCtx('s1'));

    await expect(plugin.handlers.cancel('bg_1', userCtx('s2'))).rejects.toThrow(/another session/);
    await expect(plugin.handlers.cancel('bg_1', userCtx('s1'))).resolves.toContain('cancelled');
    expect(runner.cancelled).toEqual(['bg_1']);
  });

  it('/cancel rejects empty and missing job IDs', async () => {
    const plugin = createMonitorPlugin({ health: async () => undefined });

    await expect(plugin.handlers.cancel('   ', userCtx('s1'))).rejects.toThrow(/jobID is required/);
    await expect(plugin.handlers.cancel('bg_missing', userCtx('s1'))).rejects.toThrow(/not found/);
  });

  it('background reports once on process exit', async () => {
    const runner = new FakeRunner();
    const notified: AutoSubmitRequest[] = [];
    const plugin = createMonitorPlugin({
      runner,
      health: async () => undefined,
      notify: async (request) => { notified.push(request); },
    });

    await plugin.handlers.background('echo one', userCtx('s1'));
    runner.exits.get('bg_1')?.(0);
    await vi.waitFor(() => expect(notified).toHaveLength(1));

    expect(notified[0]).toMatchObject({ sessionID: 's1', jobID: 'bg_1', kind: 'bg', submit: true });
    expect(notified[0].text).toContain('background bg_1 exited');
  });

  it('background startup failure does not leave an active job', async () => {
    const runner = new FakeRunner();
    runner.throwOnRun = true;
    const plugin = createMonitorPlugin({ runner, health: async () => undefined });

    await expect(plugin.handlers.background('echo bad', userCtx('s1'))).rejects.toThrow('spawn failed');

    const jobs = await plugin.handlers.jobs('', userCtx('s1'));
    expect(jobs).not.toContain('bg_1');
  });

  it('monitor wires runner output through delivery formatter to notifier and cleans up on exit', async () => {
    vi.useFakeTimers();
    const runner = new FakeRunner();
    const notified: AutoSubmitRequest[] = [];
    const plugin = createMonitorPlugin({
      runner,
      health: async () => undefined,
      notify: async (request) => { notified.push(request); },
    });

    await expect(plugin.handlers.monitor('--regex ERR --before 0 --after 0 --debounce 1 -- echo test', userCtx('s1')))
      .resolves.toContain('mon_1');
    expect(runner.outputHandlers.size).toBe(1);

    for (const handler of runner.outputHandlers) {
      handler({ jobID: 'mon_1', seq: 1, stream: 'stdout', line: 'ERR happened', timestamp: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(notified).toHaveLength(1));
    expect(notified[0]).toMatchObject({ sessionID: 's1', jobID: 'mon_1', kind: 'mon', submit: true });
    expect(notified[0].text).toContain('ERR happened');

    runner.exits.get('mon_1')?.(0);
    await vi.waitFor(() => expect(runner.outputHandlers.size).toBe(0));
    vi.useRealTimers();
  });

  it('monitor startup failure cleans up output handler and active runtime', async () => {
    const runner = new FakeRunner();
    runner.throwOnRun = true;
    const plugin = createMonitorPlugin({ runner, health: async () => undefined });

    await expect(plugin.handlers.monitor('--regex ERR -- echo test', userCtx('s1')))
      .rejects.toThrow('spawn failed');

    expect(runner.outputHandlers.size).toBe(0);
    const jobs = await plugin.handlers.jobs('', userCtx('s1'));
    expect(jobs).not.toContain('mon_1');
  });
});
