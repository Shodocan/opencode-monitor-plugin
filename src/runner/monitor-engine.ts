import { MONITOR_AFTER_WAIT_MS, MONITOR_RING_BUFFER_EVENTS } from '../limits.js';
import type { OutputEvent } from '../types.js';

export interface MonitorWindow {
  jobID: string;
  events: OutputEvent[];
  matchSeqs: number[];
  truncated: boolean;
}

export interface MonitorEngineOptions {
  jobID: string;
  regex: RegExp;
  before: number;
  after: number;
  debounceMs: number;
  afterWaitMs?: number;
  ringSize?: number;
  onWindow: (window: MonitorWindow) => void;
  onAfterWaitTimeout?: (jobID: string, matchSeq: number) => void;
}

interface PendingWindow {
  matchSeq: number;
  events: OutputEvent[];
  afterRemaining: number;
  truncated: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ReadyWindow {
  events: OutputEvent[];
  matchSeqs: number[];
  truncated: boolean;
}

/**
 * Builds monitor delivery windows from ProcessRunner output.
 *
 * Assumes ProcessRunner's documented seq contract: events for this engine arrive
 * in monotonically increasing seq order. Older/equal seqs are treated as
 * duplicate stale input and ignored. Delivery dedupe state is pruned to the
 * bounded ring/pending/ready window horizon after every emit.
 */
export class MonitorEngine {
  #ring: OutputEvent[] = [];
  #droppedFromRing = 0;
  #highestSeenSeq = Number.NEGATIVE_INFINITY;
  #deliveredSeqs = new Set<number>();
  #pending: PendingWindow[] = [];
  #ready: ReadyWindow[] = [];
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #destroyed = false;

  #afterWaitMs: number;
  #ringSize: number;

  constructor(private readonly opts: MonitorEngineOptions) {
    this.#afterWaitMs = opts.afterWaitMs ?? MONITOR_AFTER_WAIT_MS;
    this.#ringSize = opts.ringSize ?? MONITOR_RING_BUFFER_EVENTS;
    this.#validateOptions();
  }

  ingest(event: OutputEvent): void {
    if (this.#destroyed) return;
    if (event.jobID !== this.opts.jobID) return;
    // ProcessRunner emits globally monotonic seqs. Older or equal seqs are
    // duplicates/out-of-order and cannot safely extend pending windows.
    if (event.seq <= this.#highestSeenSeq) return;
    this.#highestSeenSeq = event.seq;

    this.#appendToPendingAfterWindows(event);
    this.#appendToRing(event);

    this.opts.regex.lastIndex = 0;
    if (!this.opts.regex.test(event.line)) return;

    const beforeEvents = this.opts.before === 0
      ? []
      : this.#ring.slice(0, -1).slice(-this.opts.before);
    const priorSeenCount = this.#droppedFromRing + Math.max(0, this.#ring.length - 1);
    const truncated = beforeEvents.length < Math.min(this.opts.before, priorSeenCount);
    const pending: PendingWindow = {
      matchSeq: event.seq,
      events: [...beforeEvents, event],
      afterRemaining: this.opts.after,
      truncated,
      timer: null,
    };

    if (pending.afterRemaining === 0) {
      this.#markReady(pending);
      return;
    }

    pending.timer = setTimeout(() => {
      if (this.#destroyed) return;
      if (!this.#pending.includes(pending)) return;
      pending.timer = null;
      this.opts.onAfterWaitTimeout?.(this.opts.jobID, pending.matchSeq);
      this.#markReady(pending);
    }, this.#afterWaitMs);
    this.#pending.push(pending);
  }

  /** Final/process-exit flush. Emits all ready and pending windows immediately. */
  flush(): void {
    if (this.#destroyed) return;
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    for (const pending of [...this.#pending]) {
      this.#markReady(pending, false);
    }
    this.#emitReady();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    for (const pending of this.#pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.#pending = [];
    this.#ready = [];
  }

  #appendToRing(event: OutputEvent): void {
    this.#ring.push(event);
    while (this.#ring.length > this.#ringSize) {
      this.#ring.shift();
      this.#droppedFromRing += 1;
    }
  }

  #appendToPendingAfterWindows(event: OutputEvent): void {
    const satisfied: PendingWindow[] = [];
    for (const pending of this.#pending) {
      if (pending.afterRemaining <= 0) continue;
      pending.events.push(event);
      pending.afterRemaining -= 1;
      if (pending.afterRemaining === 0) satisfied.push(pending);
    }
    for (const pending of satisfied) {
      this.#markReady(pending);
    }
  }

  #markReady(pending: PendingWindow, armDebounce = true): void {
    const idx = this.#pending.indexOf(pending);
    if (idx !== -1) this.#pending.splice(idx, 1);
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.#ready.push({
      events: pending.events,
      matchSeqs: [pending.matchSeq],
      truncated: pending.truncated,
    });
    if (armDebounce) this.#armDebounce();
  }

  #armDebounce(): void {
    if (this.opts.debounceMs === 0) {
      this.#emitReady();
      return;
    }
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#emitReady();
    }, this.opts.debounceMs);
  }

  #emitReady(): void {
    if (this.#ready.length === 0) return;
    const merged = this.#mergeReady();
    this.#ready = [];
    if (merged.events.length === 0) return;
    for (const event of merged.events) {
      this.#deliveredSeqs.add(event.seq);
    }
    this.#pruneDeliveredSeqs();
    this.opts.onWindow({ jobID: this.opts.jobID, ...merged });
  }

  #mergeReady(): ReadyWindow {
    const eventsBySeq = new Map<number, OutputEvent>();
    const matchSeqs = new Set<number>();
    let truncated = false;

    for (const window of this.#ready) {
      if (window.truncated) truncated = true;
      for (const event of window.events) {
        if (!this.#deliveredSeqs.has(event.seq)) eventsBySeq.set(event.seq, event);
      }
      for (const seq of window.matchSeqs) {
        if (!this.#deliveredSeqs.has(seq)) matchSeqs.add(seq);
      }
    }

    return {
      events: [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq),
      matchSeqs: [...matchSeqs].sort((a, b) => a - b),
      truncated,
    };
  }

  #pruneDeliveredSeqs(): void {
    const protectedSeqs = [
      ...this.#ring.map((event) => event.seq),
      ...this.#pending.flatMap((window) => window.events.map((event) => event.seq)),
      ...this.#ready.flatMap((window) => window.events.map((event) => event.seq)),
    ];
    if (protectedSeqs.length === 0) {
      this.#deliveredSeqs.clear();
      return;
    }
    const minProtectedSeq = Math.min(...protectedSeqs);
    for (const seq of this.#deliveredSeqs) {
      if (seq < minProtectedSeq) this.#deliveredSeqs.delete(seq);
    }
  }

  #validateOptions(): void {
    const nonNegativeIntegers: Array<[string, number]> = [
      ['before', this.opts.before],
      ['after', this.opts.after],
      ['debounceMs', this.opts.debounceMs],
      ['afterWaitMs', this.#afterWaitMs],
    ];
    for (const [name, value] of nonNegativeIntegers) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`MonitorEngine: ${name} must be a non-negative integer`);
      }
    }
    if (!Number.isInteger(this.#ringSize) || this.#ringSize <= 0) {
      throw new Error('MonitorEngine: ringSize must be a positive integer');
    }
  }
}
