import type { OutputEvent } from './types.js';
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

export function registerCommands(ctx: PluginContext, deps?: MonitorPluginDependencies): MonitorPlugin {
  const plugin = createMonitorPlugin(deps);
  plugin.registerCommands(ctx);
  return plugin;
}

export default createMonitorPlugin;
