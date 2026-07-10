import type { OutputEvent } from './types.js';
import { tool } from '@opencode-ai/plugin';
import type { PluginContext } from './plugin-context.js';
import { requireDirectUserContext } from './plugin-context.js';
import { parseBackground, parseLoop, parseMonitor, parseSchedule } from './parser/index.js';
import { JobRegistry } from './registry/job-registry.js';
import { ProcessRunner } from './runner/process-runner.js';
import { MonitorEngine, type MonitorWindow } from './runner/monitor-engine.js';
import { PromptScheduler, type LoopConfig, type ScheduleConfig } from './scheduler/prompt-scheduler.js';
import { formatAutoSubmit, formatCancel, formatDelivery, formatJobs } from './delivery/delivery-formatter.js';
import { appendSubmitToSession, health as bridgeHealth } from './delivery/notifier.js';
import type { AutoSubmitRequest, JobKind, OutputStream } from './types.js';
import { BridgeServer, type PromptSyntheticNotification } from './bridge/server.js';
import { type MonitorIndicatorSnapshot, writeMonitorStatus, writeMonitorTail, removeMonitorTail } from './status-store.js';
import { monitorDebug } from './debug-log.js';

type CommandHandler = (raw: string, ctx: PluginContext) => Promise<string>;

interface RunnerLike {
  run(jobID: string, command: string): { jobID: string; exitPromise: Promise<number | null> };
  cancel(jobID: string): Promise<void>;
  tail(jobID: string, stream: OutputStream): string[];
  dispose(jobID: string): void;
  on?(event: 'output', handler: (event: OutputEvent) => void): unknown;
  off?(event: 'output', handler: (event: OutputEvent) => void): unknown;
}

interface SchedulerLike {
  scheduleLoop(cfg: LoopConfig): void;
  scheduleOnce(cfg: ScheduleConfig): void;
  cancel(jobID: string): boolean;
  pendingCount: number;
}

export interface MonitorPluginDependencies {
  registry?: JobRegistry;
  runner?: RunnerLike;
  scheduler?: SchedulerLike;
  notify?: (request: AutoSubmitRequest) => Promise<void>;
  health?: () => Promise<unknown>;
  now?: () => Date;
  onStatusChange?: (snapshot: MonitorIndicatorSnapshot) => void;
  statusScope?: string;
  getQueueDepth?: () => number;
  getDedupedCount?: () => number;
  getCoalescedTicks?: () => number;
  getBridgeUp?: () => boolean;
  getScheduledPending?: () => number;
}

export interface MonitorPlugin {
  registerCommands(ctx: PluginContext): void;
  handlers: Record<string, CommandHandler>;
  getScheduledPending: () => number;
}

interface OpencodePluginInput {
  client?: {
    session?: {
      promptAsync?: (options: {
        path: { id: string };
        query?: { directory?: string };
        body: {
          agent?: string;
          parts: Array<{
            type: 'text';
            text: string;
            synthetic: true;
            metadata: Record<string, unknown>;
          }>;
        };
      }) => Promise<unknown>;
    };
  };
  directory?: string;
  worktree?: string;
  serverUrl?: URL;
}

interface OpencodeConfigLike {
  command?: Record<string, { template: string; description?: string }>;
}

type SessionPromptAsyncBody = NonNullable<NonNullable<OpencodePluginInput['client']>['session']> extends { promptAsync?: (options: infer Options) => Promise<unknown> }
  ? Options
  : never;

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  background: 'Run a shell command in the background and report when it exits.',
  monitor: 'Run a shell command and report matching output windows.',
  loop: 'Repeatedly submit a prompt on an interval.',
  schedule: 'Submit a prompt once in the future.',
  jobs: 'List opencode-monitor jobs for this session.',
  cancel: 'Cancel an opencode-monitor job for this session.',
};

const COMMAND_TEMPLATES: Record<string, string> = {
  background: 'Use the `opencode_monitor_background` tool with command exactly as written below. Return the tool result.\n\n$ARGUMENTS',
  monitor: 'Use the `opencode_monitor_monitor` tool. Pass the raw monitor arguments exactly as written below. Return the tool result.\n\n$ARGUMENTS',
  loop: 'Use the `opencode_monitor_loop` tool. Pass the raw loop arguments exactly as written below. Return the tool result.\n\n$ARGUMENTS',
  schedule: 'Use the `opencode_monitor_schedule` tool. Pass the raw schedule arguments exactly as written below. Return the tool result.\n\n$ARGUMENTS',
  jobs: 'Use the `opencode_monitor_jobs` tool and return the tool result.\n\n$ARGUMENTS',
  cancel: 'Use the `opencode_monitor_cancel` tool with the job ID exactly as written below. Return the tool result.\n\n$ARGUMENTS',
};

interface JobRuntime {
  sessionID: string;
  kind: JobKind;
  dispose?: () => void | Promise<void>;
}

function windowToText(window: MonitorWindow): string {
  const matchList = window.matchSeqs.length > 0 ? window.matchSeqs.join(', ') : 'none';
  const lines = [
    `monitor ${window.jobID} matched seq(s): ${matchList}`,
    ...(window.truncated ? ['... (earlier lines omitted)'] : []),
    ...window.events.map((event) => `[${event.stream}] ${event.line}`),
  ];
  return lines.join('\n');
}

function backgroundText(jobID: string, code: number | null, runner: RunnerLike): string {
  const stdout = runner.tail(jobID, 'stdout').map((line) => `[stdout] ${line}`);
  const stderr = runner.tail(jobID, 'stderr').map((line) => `[stderr] ${line}`);
  return [`background ${jobID} exited with code ${code ?? 'null'}`, ...stdout, ...stderr].join('\n');
}

export function createMonitorPlugin(deps: MonitorPluginDependencies = {}): MonitorPlugin {
  const registry = deps.registry ?? new JobRegistry('plugin');
  const runner = deps.runner ?? new ProcessRunner();
  const notify = deps.notify ?? appendSubmitToSession;
  const health = deps.health ?? bridgeHealth;
  const now = deps.now ?? (() => new Date());
  const runtimes = new Map<string, JobRuntime>();
  const tailJobs = new Set<string>(); // jobIDs that have output tails (bg, mon)
  const tailWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const flushTail = (jobID: string) => {
    const scope = deps.statusScope ?? process.cwd();
    const stdoutLines = runner.tail(jobID, 'stdout').map((line) => ({ stream: 'stdout', line }));
    const stderrLines = runner.tail(jobID, 'stderr').map((line) => ({ stream: 'stderr', line }));
    const allLines = [...stdoutLines, ...stderrLines].slice(-3);
    const truncated = allLines.length >= 3;
    void writeMonitorTail(scope, jobID, allLines, truncated).catch((error) => {
      monitorDebug('tail.write.error', { jobID, error: error instanceof Error ? error.message : String(error) });
    });
  };

  const scheduleTailWrite = (jobID: string) => {
    if (!tailJobs.has(jobID)) return;
    const existing = tailWriteTimers.get(jobID);
    if (existing) return; // already scheduled within debounce window
    const timer = setTimeout(() => {
      tailWriteTimers.delete(jobID);
      flushTail(jobID);
    }, 1000);
    tailWriteTimers.set(jobID, timer);
  };

  const cleanupTail = (jobID: string) => {
    const timer = tailWriteTimers.get(jobID);
    if (timer) { clearTimeout(timer); tailWriteTimers.delete(jobID); }
    tailJobs.delete(jobID);
    const scope = deps.statusScope ?? process.cwd();
    void removeMonitorTail(scope, jobID);
  };

  const emitStatus = () => {
    const timestamp = Date.now();
    const allJobs = registry.list();
    const completedCount = allJobs.filter((j) => j.status === 'completed').length;
    const failedCount = allJobs.filter((j) => j.status === 'failed').length;
    const queueDropped = allJobs.reduce((sum, j) => sum + (j.queueDroppedCount ?? 0), 0);
    const snapshot: MonitorIndicatorSnapshot = {
      version: 2,
      updatedAt: timestamp,
      jobs: allJobs
        .filter((job) => runtimes.has(job.jobID))
        .map((job) => ({
          jobID: job.jobID,
          kind: job.kind,
          sessionID: runtimes.get(job.jobID)!.sessionID,
          status: job.status,
          startedAt: timestamp,
          updatedAt: timestamp,
          createdAt: job.createdAt,
          deliveryStatus: job.deliveryStatus ?? 'unknown',
          hasTail: tailJobs.has(job.jobID),
        })),
      queueDepth: deps.getQueueDepth?.() ?? 0,
      dedupedCount: deps.getDedupedCount?.() ?? 0,
      coalescedTicks: deps.getCoalescedTicks?.() ?? 0,
      bridgeUp: deps.getBridgeUp?.() ?? true,
      queueDropped,
      completedCount,
      failedCount,
      scheduledPending: deps.getScheduledPending?.() ?? 0,
    };
    monitorDebug('plugin.status.emit', { jobs: snapshot.jobs.length, queueDepth: snapshot.queueDepth, bridgeUp: snapshot.bridgeUp });
    deps.onStatusChange?.(snapshot);
  };

  const deliver = async (request: AutoSubmitRequest, preformatted = false): Promise<void> => {
    const text = preformatted || request.kind === 'loop' || request.kind === 'sched'
      ? request.text
      : formatAutoSubmit(request);
    monitorDebug('plugin.deliver.start', { jobID: request.jobID, kind: request.kind, sessionID: request.sessionID, textPreview: text.slice(0, 120) });
    await notify({ ...request, text });
    monitorDebug('plugin.deliver.ok', { jobID: request.jobID, kind: request.kind, sessionID: request.sessionID });
    registry.updateDeliveryStatus(request.jobID, 'sent');
    if (request.kind === 'sched') {
      registry.complete(request.jobID);
      runtimes.delete(request.jobID);
      emitStatus();
    }
  };

  const scheduler = deps.scheduler ?? new PromptScheduler({
    delivery: (request) => deliver(request).catch((error) => failJob(request.jobID, error)),
  });

  const ensureBridgeAvailable = async (): Promise<void> => {
    await health();
  };

  const registerRuntime = (jobID: string, sessionID: string, kind: JobKind, dispose?: JobRuntime['dispose']) => {
    monitorDebug('plugin.job.register', { jobID, kind, sessionID });
    runtimes.set(jobID, { sessionID, kind, dispose });
    emitStatus();
  };

  const failJob = (jobID: string, error: unknown) => {
    monitorDebug('plugin.job.fail', { jobID, error: error instanceof Error ? error.message : String(error) });
    registry.fail(jobID, 'bridge_failed');
    runtimes.delete(jobID);
    emitStatus();
    // Keep errors out of visible prompts; job state exposes failure.
    void error;
  };

  const handlers: Record<string, CommandHandler> = {
    background: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const agent = ctx.agent;
      const parsed = parseBackground(raw);
      monitorDebug('plugin.background.start', { sessionID, command: parsed.command });
      await ensureBridgeAvailable();
      const jobID = registry.register('bg');
      tailJobs.add(jobID);
      registerRuntime(jobID, sessionID, 'bg', () => runner.cancel(jobID));

      try {
        const handle = runner.run(jobID, parsed.command);
        // Wire output events for tail writing
        const bgOutputHandler = (event: OutputEvent) => {
          if (event.jobID === jobID) scheduleTailWrite(jobID);
        };
        runner.on?.('output', bgOutputHandler);
        void handle.exitPromise.then(async (code) => {
          monitorDebug('plugin.background.runner.exit', { jobID, sessionID, code });
          try {
            flushTail(jobID);
            const formatted = formatDelivery(backgroundText(jobID, code, runner)).text;
            await deliver({ sessionID, agent, jobID, kind: 'bg', text: formatted, submit: true }, true);
            registry.complete(jobID);
          } catch (error) {
            failJob(jobID, error);
          } finally {
            if (bgOutputHandler) runner.off?.('output', bgOutputHandler);
            runner.dispose(jobID);
            runtimes.delete(jobID);
            cleanupTail(jobID);
            emitStatus();
          }
        }).catch((error) => {
          failJob(jobID, error);
          if (bgOutputHandler) runner.off?.('output', bgOutputHandler);
          runner.dispose(jobID);
          runtimes.delete(jobID);
          cleanupTail(jobID);
          emitStatus();
        });
      } catch (error) {
        runtimes.delete(jobID);
        cleanupTail(jobID);
        registry.fail(jobID);
        emitStatus();
        throw error;
      }

      return `started ${jobID}`;
    },

    monitor: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const agent = ctx.agent;
      const parsed = parseMonitor(raw);
      monitorDebug('plugin.monitor.start', {
        sessionID,
        raw,
        regex: parsed.regex.source,
        flags: parsed.regex.flags,
        before: parsed.before,
        after: parsed.after,
        debounceMs: parsed.debounceMs,
        command: parsed.command,
        runnerOn: Boolean(runner.on),
      });
      await ensureBridgeAvailable();
      const jobID = registry.register('mon');
      tailJobs.add(jobID);
      let engine: MonitorEngine | undefined;
      let outputHandler: ((event: OutputEvent) => void) | undefined;

      const cleanup = () => {
        engine?.destroy();
        if (outputHandler && runner.off) runner.off('output', outputHandler);
        runner.dispose(jobID);
        runtimes.delete(jobID);
        cleanupTail(jobID);
        emitStatus();
      };
      registerRuntime(jobID, sessionID, 'mon', async () => {
        await runner.cancel(jobID);
        cleanup();
      });

      try {
        engine = new MonitorEngine({
          jobID,
          regex: parsed.regex,
          before: parsed.before,
          after: parsed.after,
          debounceMs: parsed.debounceMs,
          onWindow: (window) => {
            monitorDebug('plugin.monitor.window', { jobID, sessionID, matchSeqs: window.matchSeqs, eventSeqs: window.events.map((event) => event.seq) });
            const formatted = formatDelivery(windowToText(window)).text;
            void deliver({ sessionID, agent, jobID, kind: 'mon', text: formatted, submit: true }, true)
              .catch((error) => failJob(jobID, error));
          },
        });
        outputHandler = (event: OutputEvent) => {
          if (event.jobID === jobID) {
            monitorDebug('plugin.monitor.output', { jobID, seq: event.seq, stream: event.stream, line: event.line });
            scheduleTailWrite(jobID);
          }
          engine?.ingest(event);
        };
        runner.on?.('output', outputHandler);
        const handle = runner.run(jobID, parsed.command);
        monitorDebug('plugin.monitor.runner.started', { jobID, sessionID });
        void handle.exitPromise.then((code) => {
          monitorDebug('plugin.monitor.runner.exit', { jobID, sessionID, code });
          engine?.flush();
          registry.complete(jobID);
          cleanup();
        }).catch((error) => {
          failJob(jobID, error);
          cleanup();
        });
      } catch (error) {
        cleanup();
        registry.fail(jobID);
        emitStatus();
        throw error;
      }

      return `started ${jobID}`;
    },

    loop: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const agent = ctx.agent;
      const parsed = parseLoop(raw);
      await ensureBridgeAvailable();
      const jobID = registry.register('loop');
      registerRuntime(jobID, sessionID, 'loop', () => { scheduler.cancel(jobID); });
      try {
        scheduler.scheduleLoop({ jobID, sessionID, agent, intervalMs: parsed.intervalMs, prompt: parsed.prompt });
      } catch (error) {
        runtimes.delete(jobID);
        registry.fail(jobID);
        emitStatus();
        throw error;
      }
      return `started ${jobID}`;
    },

    schedule: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const agent = ctx.agent;
      const parsed = parseSchedule(raw, now());
      await ensureBridgeAvailable();
      const jobID = registry.register('sched');
      registerRuntime(jobID, sessionID, 'sched', () => { scheduler.cancel(jobID); });
      try {
        scheduler.scheduleOnce({ jobID, sessionID, agent, runAt: parsed.runAt, prompt: parsed.prompt });
      } catch (error) {
        runtimes.delete(jobID);
        registry.fail(jobID);
        emitStatus();
        throw error;
      }
      return `scheduled ${jobID}`;
    },

    jobs: async (_raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const jobs = registry.list().filter((job) => runtimes.get(job.jobID)?.sessionID === sessionID);
      return formatJobs(jobs).text;
    },

    cancel: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const jobID = raw.trim();
      if (!jobID) throw new Error('jobID is required');
      const runtime = runtimes.get(jobID);
      if (runtime && runtime.sessionID !== sessionID) {
        throw new Error(`job ${jobID} belongs to another session`);
      }
      const status = registry.get(jobID);
      if (!status || !runtime) throw new Error(`job ${jobID} not found`);
      await runtime.dispose?.();
      registry.cancel(jobID);
      runtimes.delete(jobID);
      emitStatus();
      return formatCancel(jobID, status.kind).text;
    },
  };

  return {
    handlers,
    getScheduledPending: () => scheduler.pendingCount,
    registerCommands(ctx: PluginContext): void {
      for (const [name, handler] of Object.entries(handlers)) {
        ctx.registerSlashCommand(name, handler);
      }
    },
  };
}

export function registerCommands(ctx: PluginContext | OpencodePluginInput, deps?: MonitorPluginDependencies): MonitorPlugin | Promise<unknown> {
  if (typeof (ctx as PluginContext).registerSlashCommand !== 'function') {
    return server(ctx as OpencodePluginInput);
  }
  const plugin = createMonitorPlugin(deps);
  plugin.registerCommands(ctx as PluginContext);
  return plugin;
}

async function submitVisibleSyntheticPrompt(input: OpencodePluginInput, payload: PromptSyntheticNotification): Promise<void> {
  const query = input.directory ? { directory: input.directory } : undefined;
  const options: SessionPromptAsyncBody = {
    path: { id: payload.params.sessionID },
    query,
    body: {
      ...(payload.agent ? { agent: payload.agent } : {}),
      parts: [{
        type: 'text',
        text: payload.params.text,
        synthetic: true,
        metadata: {
          opencodeMcpVisible: true,
          opencodeMonitorJobID: payload.jobID,
          opencodeMonitorKind: payload.kind,
        },
      }],
    },
  };

  monitorDebug('plugin.session.promptAsync.start', {
    sessionID: payload.params.sessionID,
    jobID: payload.jobID,
    kind: payload.kind,
    visible: true,
    hasClientPromptAsync: Boolean(input.client?.session?.promptAsync),
    hasServerUrl: Boolean(input.serverUrl),
  });
  if (input.client?.session?.promptAsync) {
    await input.client.session.promptAsync(options);
    monitorDebug('plugin.session.promptAsync.ok', { jobID: payload.jobID, path: 'client.session.promptAsync', visible: true });
    return;
  }

  if (!input.serverUrl) throw new Error('opencode client session.promptAsync is unavailable');
  const url = new URL(`/session/${encodeURIComponent(payload.params.sessionID)}/prompt_async`, input.serverUrl);
  if (input.directory) url.searchParams.set('directory', input.directory);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
  });
  if (!response.ok) throw new Error(`session prompt_async failed with status ${response.status}`);
  monitorDebug('plugin.session.promptAsync.ok', { jobID: payload.jobID, path: `/session/:id/prompt_async:${response.status}`, visible: true });
}

function sessionStatusFromEventStatus(status: unknown): 'idle' | 'busy' | 'retry' | undefined {
  if (typeof status !== 'object' || status === null) return undefined;
  const type = (status as { type?: unknown }).type;
  if (type === 'idle' || type === 'busy' || type === 'retry') return type;
  return undefined;
}

function armIdleFallback(bridge: BridgeServer, sessionID: string): void {
  setTimeout(() => {
    monitorDebug('server.idleFallback.fire', { sessionID });
    bridge.setSessionStatus(sessionID, 'idle');
  }, 1500).unref?.();
}

export const server = async (input: OpencodePluginInput = {}): Promise<any> => {
  const statusScope = input.worktree || input.directory || process.cwd();
  monitorDebug('server.start', { statusScope, directory: input.directory, worktree: input.worktree, hasClientPromptAsync: Boolean(input.client?.session?.promptAsync), hasServerUrl: Boolean(input.serverUrl) });
  const publishStatus = (snapshot: MonitorIndicatorSnapshot) => {
    monitorDebug('server.status.write.request', { statusScope, jobs: snapshot.jobs.map((job) => ({ jobID: job.jobID, kind: job.kind, sessionID: job.sessionID, status: job.status })) });
    void writeMonitorStatus(statusScope, snapshot).catch((error) => {
      console.error('opencode-monitor status write failed', error instanceof Error ? error.message : String(error));
    });
  };
  const bridge = new BridgeServer({
    onAppend: (payload) => {
      monitorDebug('server.bridge.onAppend', { jobID: payload.jobID, kind: payload.kind, sessionID: payload.params.sessionID, method: payload.method });
      void submitVisibleSyntheticPrompt(input, payload).catch((error) => {
        monitorDebug('server.bridge.onAppend.error', { jobID: payload.jobID, error: error instanceof Error ? error.message : String(error) });
        console.error('opencode-monitor prompt delivery failed', error instanceof Error ? error.message : String(error));
      });
      return true;
    },
  });
  await bridge.start();
  monitorDebug('server.bridge.started', {});
  const plugin = createMonitorPlugin({
    health: async () => undefined,
    notify: async (request) => bridge.notify(request),
    onStatusChange: publishStatus,
    statusScope,
    getQueueDepth: () => bridge.idleQueue.pendingCount,
    getDedupedCount: () => bridge.idleQueue.deduped,
    getCoalescedTicks: () => bridge.idleQueue.peek().reduce((sum, e) => sum + (e.coalescedTickCount ?? 0), 0),
    getBridgeUp: () => true,
    getScheduledPending: () => scheduledPendingHolder.value,
  });
  const scheduledPendingHolder = { value: 0 };
  // Update scheduled pending periodically via the plugin's accessor
  const scheduledPendingTimer = setInterval(() => { scheduledPendingHolder.value = plugin.getScheduledPending(); }, 1000);
  scheduledPendingTimer.unref?.();
  publishStatus({ version: 2, updatedAt: Date.now(), jobs: [], queueDepth: 0, dedupedCount: 0, coalescedTicks: 0, bridgeUp: true, queueDropped: 0, completedCount: 0, failedCount: 0, scheduledPending: 0 });
  return {
    __stop: async () => {
      clearInterval(scheduledPendingTimer);
      await bridge.stop();
    },
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      if (event.type === 'session.status') {
        const sessionID = event.properties?.sessionID;
        const status = sessionStatusFromEventStatus(event.properties?.status);
        if (typeof sessionID === 'string') {
          monitorDebug('server.event.session.status', { sessionID, status });
          bridge.setSessionStatus(sessionID, status);
        }
      }
      if (event.type === 'session.idle') {
        const sessionID = event.properties?.sessionID;
        if (typeof sessionID === 'string') {
          monitorDebug('server.event.session.idle', { sessionID });
          bridge.setSessionStatus(sessionID, 'idle');
        }
      }
    },
    config: async (config: OpencodeConfigLike) => {
      config.command ??= {};
      for (const [name, description] of Object.entries(COMMAND_DESCRIPTIONS)) {
        config.command[name] = { template: COMMAND_TEMPLATES[name] ?? '$ARGUMENTS', description };
      }
    },
    tool: {
      opencode_monitor_background: tool({
        description: 'Start a shell command in the background. Returns immediately with the job ID; final output is delivered to the session when idle.',
        args: { command: tool.schema.string().describe('Command to run via /bin/sh -c') },
        async execute(args, context) {
          monitorDebug('tool.background.execute', { sessionID: context.sessionID, command: args.command });
          bridge.setSessionStatus(context.sessionID, 'busy');
          try {
            return await plugin.handlers.background(args.command, toolPluginContext(context.sessionID, context.agent));
          } finally {
            armIdleFallback(bridge, context.sessionID);
          }
        },
      }),
      opencode_monitor_monitor: tool({
        description: 'Start a monitored shell command. Raw args use /monitor syntax, including --regex and command after --.',
        args: { raw: tool.schema.string().describe('Raw /monitor arguments') },
        async execute(args, context) {
          monitorDebug('tool.monitor.execute', { sessionID: context.sessionID, raw: args.raw });
          bridge.setSessionStatus(context.sessionID, 'busy');
          try {
            return await plugin.handlers.monitor(args.raw, toolPluginContext(context.sessionID, context.agent));
          } finally {
            armIdleFallback(bridge, context.sessionID);
          }
        },
      }),
      opencode_monitor_loop: tool({
        description: 'Start a prompt loop. Raw args use /loop syntax: <interval> <prompt>.',
        args: { raw: tool.schema.string().describe('Raw /loop arguments') },
        async execute(args, context) {
          bridge.setSessionStatus(context.sessionID, 'busy');
          try {
            return await plugin.handlers.loop(args.raw, toolPluginContext(context.sessionID, context.agent));
          } finally {
            armIdleFallback(bridge, context.sessionID);
          }
        },
      }),
      opencode_monitor_schedule: tool({
        description: 'Schedule one prompt. Raw args use /schedule syntax: in <duration> <prompt> or at <iso-date> <prompt>.',
        args: { raw: tool.schema.string().describe('Raw /schedule arguments') },
        async execute(args, context) {
          bridge.setSessionStatus(context.sessionID, 'busy');
          try {
            return await plugin.handlers.schedule(args.raw, toolPluginContext(context.sessionID, context.agent));
          } finally {
            armIdleFallback(bridge, context.sessionID);
          }
        },
      }),
      opencode_monitor_jobs: tool({
        description: 'List opencode-monitor jobs owned by the current session.',
        args: {},
        async execute(_args, context) {
          return plugin.handlers.jobs('', toolPluginContext(context.sessionID, context.agent));
        },
      }),
      opencode_monitor_cancel: tool({
        description: 'Cancel an opencode-monitor job owned by the current session.',
        args: { jobID: tool.schema.string().describe('Job ID to cancel') },
        async execute(args, context) {
          return plugin.handlers.cancel(args.jobID, toolPluginContext(context.sessionID, context.agent));
        },
      }),
    },
  };
};

function toolPluginContext(sessionID: string, agent?: string): PluginContext {
  return { sessionID, agent, invocationOrigin: 'user', registerSlashCommand: () => {} };
}

export default server;
