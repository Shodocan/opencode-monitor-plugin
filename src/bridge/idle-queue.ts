import type { AutoSubmitRequest, JobKind } from '../types.js';
import {
  MAX_PENDING_PER_JOB,
  MAX_PENDING_GLOBAL,
  MAX_QUEUE_BYTES_TOTAL,
} from '../limits.js';

// ----------------------------------------------------------------
// Session status type
// ----------------------------------------------------------------

export type SessionStatus = 'idle' | 'busy' | 'retry';

/** Status object returned by the session-status helper. */
export interface StatusInfo {
  type: SessionStatus;
}

/**
 * Resolve session status from an external provider.
 * Unknown values are treated as `'busy'`.
 */
export function isIdle(status: SessionStatus | undefined): boolean {
  return status === 'idle';
}

// ----------------------------------------------------------------
// Pending entry held in the idle queue
// ----------------------------------------------------------------

export interface IdlePendingEntry {
  req: AutoSubmitRequest;
  byteSize: number;
  /** true for /loop coalesced entries */
  coalesced?: boolean;
  /** tick count carried only for /loop coalesced entries */
  coalescedTickCount?: number;
}

// ----------------------------------------------------------------
// IdleQueue
// ----------------------------------------------------------------

export class IdleQueue {
  #sessionStatus: SessionStatus | undefined;
  #pending: Map<string, IdlePendingEntry>;
  #globalOrder: string[];

  byteSize = 0;
  dropped = 0;

  /**
   * Synchronous delivery handler.  Returns `true` on success;
   * return `false` to stop the current flush (tail retained).
   */
  onDelivery: (req: AutoSubmitRequest) => boolean;

  constructor(
    sessionStatus: SessionStatus | undefined,
    onDelivery: (req: AutoSubmitRequest) => boolean,
  ) {
    this.#sessionStatus = sessionStatus;
    this.onDelivery = onDelivery;
    this.#pending = new Map();
    this.#globalOrder = [];
  }

  // -- Public read-only accessors --------------------------------

  /** Total number of pending entries (including coalesced). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Session status as cached by this instance. */
  get status(): SessionStatus | undefined {
    return this.#sessionStatus;
  }

  /** Inspect pending entries (read-only). */
  peek(): IdlePendingEntry[] {
    return Array.from(this.#pending.values());
  }

  // -- Status ---------------------------------------------------

  /**
   * Update session status and flush when the session becomes idle.
   */
  setSessionStatus(status: SessionStatus | undefined): void {
    this.#sessionStatus = status;
    if (isIdle(status) && this.#pending.size > 0) {
      this.flush();
    }
  }

  // -- Delivery entry point -------------------------------------

  /**
   * Queue a request for bridge delivery.
   *
   * If the session is busy / retry / unknown the request is queued.
   * If idle and nothing is already flushing, the queue is flushed
   * immediately.
   */
  deliver(req: AutoSubmitRequest): void {
    this.enqueue(req);
    if (isIdle(this.#sessionStatus)) {
      this.flush();
    }
  }

  // -- Flush --------------------------------------------------

  #flushing = false;

  flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;

    while (this.#globalOrder.length > 0) {
      if (!isIdle(this.#sessionStatus)) break;

      const key = this.#globalOrder.shift()!;
      const entry = this.#pending.get(key);
      if (!entry) continue;

      const ok = this.onDelivery(entry.req);
      this.#pending.delete(key);
      this.byteSize -= entry.byteSize;
      if (!ok) break;
    }

    this.#flushing = false;
  }

  // -- Enqueue with caps ----------------------------------------

  enqueue(req: AutoSubmitRequest): void {
    const byteSize = this.#measureBytes(req);
    if (req.kind === 'loop') {
      this.#enqueueLoop(req, byteSize);
    } else {
      this.#enqueueStandard(req, byteSize);
    }
  }

  #key(req: AutoSubmitRequest): string {
    return `${req.sessionID}::${req.jobID}`;
  }

  #enqueueLoop(req: AutoSubmitRequest, byteSize: number): void {
    const key = this.#key(req);
    const existing = this.#pending.get(key);

    // Coalesce: replace latest, bump tick count
    if (existing && existing.coalesced) {
      const prevBytes = existing.byteSize;
      existing.req = req;
      existing.byteSize = byteSize;
      existing.coalescedTickCount = (existing.coalescedTickCount ?? 1) + 1;
      this.byteSize += byteSize - prevBytes;
      return;
    }

    const entry: IdlePendingEntry = {
      req,
      byteSize,
      coalesced: true,
      coalescedTickCount: 1,
    };
    this.#applyCaps(req.jobID);
    this.#pending.set(key, entry);
    this.#globalOrder.push(key);
    this.byteSize += byteSize;
  }

  #enqueueStandard(req: AutoSubmitRequest, byteSize: number): void {
    const key = this.#key(req);
    const entry: IdlePendingEntry = { req, byteSize };
    this.#applyCaps(req.jobID);

    // Per-job cap: check count for this specific job before enqueueing
    const jobEntries = this.#countJobEntries(req.jobID);
    if (jobEntries >= MAX_PENDING_PER_JOB) {
      this.#evictOldestForJob(req.jobID);
    }

    this.#pending.set(key, entry);
    this.#globalOrder.push(key);
    this.byteSize += byteSize;
  }

  #applyCaps(jobID: string): void {
    // Global cap
    while (this.#pending.size >= MAX_PENDING_GLOBAL) {
      this.#evictFifo();
    }
    // Byte cap
    while (this.byteSize >= MAX_QUEUE_BYTES_TOTAL) {
      this.#evictFifo();
    }
  }

  #countJobEntries(jobID: string): number {
    let count = 0;
    for (const [, entry] of this.#pending) {
      if (entry.req.jobID === jobID) count += 1;
    }
    return count;
  }

  #evictFifo(): void {
    for (const key of this.#globalOrder) {
      const entry = this.#pending.get(key);
      if (!entry || entry.coalesced) continue;
      this.#pending.delete(key);
      this.#globalOrder.shift();
      this.byteSize -= entry.byteSize;
      this.dropped += 1;
      return;
    }
  }

  #evictOldestForJob(jobID: string): void {
    for (const key of this.#globalOrder) {
      const entry = this.#pending.get(key);
      if (!entry || entry.req.jobID !== jobID) continue;
      this.#pending.delete(key);
      this.#globalOrder.splice(this.#globalOrder.indexOf(key), 1);
      this.byteSize -= entry.byteSize;
      this.dropped += 1;
      return;
    }
  }

  #measureBytes(req: AutoSubmitRequest): number {
    return new TextEncoder().encode(req.text).length;
  }
}

export default IdleQueue;
