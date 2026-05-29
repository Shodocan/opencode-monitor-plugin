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
import { BridgeServer, type AppendNotification } from './bridge/server.js';

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
}

export interface MonitorPluginDependencies {
  registry?: JobRegistry;
  runner?: RunnerLike;
  scheduler?: SchedulerLike;
  notify?: (request: AutoSubmitRequest) => Promise<void>;
  health?: () => Promise<unknown>;
  now?: () => Date;
}

export interface MonitorPlugin {
  registerCommands(ctx: PluginContext): void;
  handlers: Record<string, CommandHandler>;
}

interface OpencodePluginInput {
  directory?: string;
  serverUrl?: URL;
}

interface OpencodeConfigLike {
  command?: Record<string, { template: string; description?: string }>;
}

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

  const deliver = async (request: AutoSubmitRequest, preformatted = false): Promise<void> => {
    const text = preformatted ? request.text : formatAutoSubmit(request);
    await notify({ ...request, text });
    registry.updateDeliveryStatus(request.jobID, 'sent');
    if (request.kind === 'sched') {
      registry.complete(request.jobID);
      runtimes.delete(request.jobID);
    }
  };

  const scheduler = deps.scheduler ?? new PromptScheduler({
    delivery: (request) => deliver(request).catch((error) => failJob(request.jobID, error)),
  });

  const ensureBridgeAvailable = async (): Promise<void> => {
    await health();
  };

  const registerRuntime = (jobID: string, sessionID: string, kind: JobKind, dispose?: JobRuntime['dispose']) => {
    runtimes.set(jobID, { sessionID, kind, dispose });
  };

  const failJob = (jobID: string, error: unknown) => {
    registry.fail(jobID, 'bridge_failed');
    // Keep errors out of visible prompts; job state exposes failure.
    void error;
  };

  const handlers: Record<string, CommandHandler> = {
    background: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const parsed = parseBackground(raw);
      await ensureBridgeAvailable();
      const jobID = registry.register('bg');
      registerRuntime(jobID, sessionID, 'bg', () => runner.cancel(jobID));

      try {
        const handle = runner.run(jobID, parsed.command);
        void handle.exitPromise.then(async (code) => {
          try {
            const formatted = formatDelivery(backgroundText(jobID, code, runner)).text;
            await deliver({ sessionID, jobID, kind: 'bg', text: formatted, submit: true }, true);
            registry.complete(jobID);
          } catch (error) {
            failJob(jobID, error);
          } finally {
            runner.dispose(jobID);
            runtimes.delete(jobID);
          }
        }).catch((error) => {
          failJob(jobID, error);
          runner.dispose(jobID);
          runtimes.delete(jobID);
        });
      } catch (error) {
        runtimes.delete(jobID);
        registry.fail(jobID);
        throw error;
      }

      return `started ${jobID}`;
    },

    monitor: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const parsed = parseMonitor(raw);
      await ensureBridgeAvailable();
      const jobID = registry.register('mon');
      let engine: MonitorEngine | undefined;
      let outputHandler: ((event: OutputEvent) => void) | undefined;

      const cleanup = () => {
        engine?.destroy();
        if (outputHandler && runner.off) runner.off('output', outputHandler);
        runner.dispose(jobID);
        runtimes.delete(jobID);
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
            const formatted = formatDelivery(windowToText(window)).text;
            void deliver({ sessionID, jobID, kind: 'mon', text: formatted, submit: true }, true)
              .catch((error) => failJob(jobID, error));
          },
        });
        outputHandler = (event: OutputEvent) => engine?.ingest(event);
        runner.on?.('output', outputHandler);
        const handle = runner.run(jobID, parsed.command);
        void handle.exitPromise.then(() => {
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
        throw error;
      }

      return `started ${jobID}`;
    },

    loop: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const parsed = parseLoop(raw);
      await ensureBridgeAvailable();
      const jobID = registry.register('loop');
      registerRuntime(jobID, sessionID, 'loop', () => { scheduler.cancel(jobID); });
      try {
        scheduler.scheduleLoop({ jobID, sessionID, intervalMs: parsed.intervalMs, prompt: parsed.prompt });
      } catch (error) {
        runtimes.delete(jobID);
        registry.fail(jobID);
        throw error;
      }
      return `started ${jobID}`;
    },

    schedule: async (raw, ctx) => {
      const sessionID = requireDirectUserContext(ctx);
      const parsed = parseSchedule(raw, now());
      await ensureBridgeAvailable();
      const jobID = registry.register('sched');
      registerRuntime(jobID, sessionID, 'sched', () => { scheduler.cancel(jobID); });
      try {
        scheduler.scheduleOnce({ jobID, sessionID, runAt: parsed.runAt, prompt: parsed.prompt });
      } catch (error) {
        runtimes.delete(jobID);
        registry.fail(jobID);
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
      return formatCancel(jobID, status.kind).text;
    },
  };

  return {
    handlers,
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

async function publishAppendToTui(input: OpencodePluginInput, payload: AppendNotification): Promise<void> {
  if (!input.serverUrl) return;
  const url = new URL('/tui/append-prompt', input.serverUrl);
  if (input.directory) url.searchParams.set('directory', input.directory);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload.params),
  });
  if (!response.ok) throw new Error(`tui append failed with status ${response.status}`);
}

function sessionStatusFromEventStatus(status: unknown): 'idle' | 'busy' | 'retry' | undefined {
  if (typeof status !== 'object' || status === null) return undefined;
  const type = (status as { type?: unknown }).type;
  if (type === 'idle' || type === 'busy' || type === 'retry') return type;
  return undefined;
}

export const server = async (input: OpencodePluginInput = {}): Promise<any> => {
  const bridge = new BridgeServer({
    onAppend: (payload) => {
      void publishAppendToTui(input, payload).catch(() => {});
      return true;
    },
  });
  await bridge.start();
  const plugin = createMonitorPlugin({
    health: () => bridgeHealth(),
    notify: (request) => appendSubmitToSession(request),
  });
  return {
    __stop: async () => bridge.stop(),
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      if (event.type === 'session.status') {
        const sessionID = event.properties?.sessionID;
        const status = sessionStatusFromEventStatus(event.properties?.status);
        if (typeof sessionID === 'string') bridge.setSessionStatus(sessionID, status);
      }
      if (event.type === 'session.idle') {
        const sessionID = event.properties?.sessionID;
        if (typeof sessionID === 'string') bridge.setSessionStatus(sessionID, 'idle');
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
          bridge.setSessionStatus(context.sessionID, 'busy');
          return plugin.handlers.background(args.command, toolPluginContext(context.sessionID));
        },
      }),
      opencode_monitor_monitor: tool({
        description: 'Start a monitored shell command. Raw args use /monitor syntax, including --regex and command after --.',
        args: { raw: tool.schema.string().describe('Raw /monitor arguments') },
        async execute(args, context) {
          bridge.setSessionStatus(context.sessionID, 'busy');
          return plugin.handlers.monitor(args.raw, toolPluginContext(context.sessionID));
        },
      }),
      opencode_monitor_loop: tool({
        description: 'Start a prompt loop. Raw args use /loop syntax: <interval> <prompt>.',
        args: { raw: tool.schema.string().describe('Raw /loop arguments') },
        async execute(args, context) {
          bridge.setSessionStatus(context.sessionID, 'busy');
          return plugin.handlers.loop(args.raw, toolPluginContext(context.sessionID));
        },
      }),
      opencode_monitor_schedule: tool({
        description: 'Schedule one prompt. Raw args use /schedule syntax: in <duration> <prompt> or at <iso-date> <prompt>.',
        args: { raw: tool.schema.string().describe('Raw /schedule arguments') },
        async execute(args, context) {
          bridge.setSessionStatus(context.sessionID, 'busy');
          return plugin.handlers.schedule(args.raw, toolPluginContext(context.sessionID));
        },
      }),
      opencode_monitor_jobs: tool({
        description: 'List opencode-monitor jobs owned by the current session.',
        args: {},
        async execute(_args, context) {
          return plugin.handlers.jobs('', toolPluginContext(context.sessionID));
        },
      }),
      opencode_monitor_cancel: tool({
        description: 'Cancel an opencode-monitor job owned by the current session.',
        args: { jobID: tool.schema.string().describe('Job ID to cancel') },
        async execute(args, context) {
          return plugin.handlers.cancel(args.jobID, toolPluginContext(context.sessionID));
        },
      }),
    },
  };
};

function toolPluginContext(sessionID: string): PluginContext {
  return { sessionID, invocationOrigin: 'user', registerSlashCommand: () => {} };
}

export default server;
