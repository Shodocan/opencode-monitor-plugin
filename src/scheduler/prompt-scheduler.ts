import type { AutoSubmitRequest, JobKind } from '../types.js';

export type SchedulerKind = 'loop' | 'sched';

export type DeliveryCallback = (request: AutoSubmitRequest) => void | Promise<void>;

export interface LoopConfig {
  jobID: string;
  sessionID: string;
  intervalMs: number;
  prompt: string;
}

export interface ScheduleConfig {
  jobID: string;
  sessionID: string;
  runAt: Date;
  prompt: string;
}

export interface SchedulerOptions {
  delivery: DeliveryCallback;
  onDrop?: (request: AutoSubmitRequest) => void;
}

export interface ActiveTimer {
  kind: SchedulerKind;
  jobID: string;
}

export class PromptScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = new Set<string>();
  private delivery: DeliveryCallback;
  private onDrop?: (request: AutoSubmitRequest) => void;

  constructor(opts: SchedulerOptions) {
    this.delivery = opts.delivery;
    this.onDrop = opts.onDrop;
  }

  /**
   * Start a looping scheduler that fires every `intervalMs`.
   * Does not build a backlog: if a tick is still pending when the next
   * interval fires, the tick is skipped and the timer reschedules.
   */
  scheduleLoop(cfg: LoopConfig): void {
    if (this.active.has(cfg.jobID)) return;

    this.active.add(cfg.jobID);
    this.tickLoop(cfg);
  }

  /**
   * Schedule a one-shot at the given `Date`.
   * If `runAt` is in the past, fires immediately on next tick.
   */
  scheduleOnce(cfg: ScheduleConfig): void {
    if (this.active.has(cfg.jobID)) return;

    this.active.add(cfg.jobID);
    const delay = Math.max(0, cfg.runAt.getTime() - Date.now());
    const id = cfg.jobID;
    const kind: SchedulerKind = 'sched';
    const prompt = cfg.prompt;
    const sessionID = cfg.sessionID;

    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.fire({ sessionID, jobID: id, kind, text: prompt, submit: true });
      this.active.delete(id);
    }, delay);

    this.timers.set(id, timer);
  }

  /**
   * Cancel an active loop or scheduled one-shot by jobID.
   * Clears any pending timer.  If a tick just fired and is awaiting
   * delivery, the guard flag will drop the request on next access.
   */
  cancel(jobID: string): boolean {
    if (!this.active.has(jobID)) return false;
    this.active.delete(jobID);

    const timer = this.timers.get(jobID);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(jobID);
    }
    return true;
  }

  /**
   * Cancel all scheduled timers and clear bookkeeping.
   */
  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.active.clear();
  }

  /**
   * Return the set of currently tracked job IDs.
   */
  get activeJobs(): Set<string> {
    return new Set(this.active);
  }

  // ----------------------------------------------------------------
  // Internals
  // ----------------------------------------------------------------

  private tickLoop(cfg: LoopConfig): void {
    if (!this.active.has(cfg.jobID)) return;

    const request = {
      sessionID: cfg.sessionID,
      jobID: cfg.jobID,
      kind: 'loop' as JobKind,
      text: cfg.prompt,
      submit: true as const,
    };

    this.fire(request);

    const timer = setTimeout(() => {
      this.tickLoop(cfg);
    }, cfg.intervalMs);
    this.timers.set(cfg.jobID, timer);
  }

  private fire(request: AutoSubmitRequest): void {
    if (!this.active.has(request.jobID)) return;
    this.delivery(request);
  }
}
