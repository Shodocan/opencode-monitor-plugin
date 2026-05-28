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

/**
 * Check whether any session in the map is idle (used for legacy
 * constructors that pass a single status value).
 */
export function isAnyIdle(
  map: Map<string, SessionStatus>,
  sessionID?: string,
): boolean {
  if (sessionID !== undefined) {
    const status = map.get(sessionID);
    return isIdle(status);
  }
  for (const status of map.values()) {
    if (isIdle(status)) return true;
  }
  return false;
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
  /** Per-session status cache — spec requires per-session cache. */
  #sessionStatuses: Map<string, SessionStatus>;
  #pending: Map<string, IdlePendingEntry>;
  #globalOrder: string[];
  #nextEntryID = 0;

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
    this.#sessionStatuses = new Map();
    if (sessionStatus !== undefined) {
      // Legacy: single status with no sessionID is stored under a default key
      // but callers are expected to set session statuses via setSessionStatus.
      // For backwards compatibility, accept a dummy entry.
      this.#sessionStatuses.set('__default__', sessionStatus);
    }
    this.onDelivery = onDelivery;
    this.#pending = new Map();
    this.#globalOrder = [];
  }

  // -- Public read-only accessors --------------------------------

  /** Total number of pending entries (including coalesced). */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Session status for a specific session, or the first cached
   * status when no sessionID is supplied (legacy getter).
   */
  get status(): SessionStatus | undefined {
    if (this.#sessionStatuses.has('__default__')) {
      return this.#sessionStatuses.get('__default__');
    }
    const first = this.#sessionStatuses.keys().next().value;
    if (first !== undefined) {
      return this.#sessionStatuses.get(first);
    }
    return undefined;
  }

  /** Status for a specific session (per-session cache). */
  getSessionStatus(sessionID: string): SessionStatus | undefined {
    return this.#sessionStatuses.get(sessionID);
  }

  /** Inspect pending entries (read-only). */
  peek(): IdlePendingEntry[] {
    return Array.from(this.#pending.values());
  }

  // -- Status ---------------------------------------------------

  /**
   * Update status for a session and flush entries for that session
   * when it becomes idle.
   */
  setSessionStatus(
    status: SessionStatus | undefined,
    sessionID?: string,
  ): void {
    const sid = sessionID ?? '__default__';
    if (status === undefined) this.#sessionStatuses.delete(sid);
    else this.#sessionStatuses.set(sid, status);
    if (isIdle(status) && this.#pending.size > 0) {
      this.flush(sessionID);
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
    const status = this.#sessionStatuses.get(req.sessionID);
    if (isIdle(status)) {
      this.flush(req.sessionID);
    } else if (status === undefined && this.#sessionStatuses.has('__default__') && isIdle(this.status)) {
      // Legacy single-status mode used by focused unit tests.
      this.flush();
    }
  }

  // -- Flush --------------------------------------------------

  #flushing = false;

  flush(sessionID?: string): void {
    if (this.#flushing) return;
    this.#flushing = true;

    try {
      if (sessionID === undefined) {
        // Standard FIFO flush: process from head of queue.
        while (this.#globalOrder.length > 0) {
          if (!isIdle(this.status)) break;
          if (!this.#shiftAndDeliver()) break;
        }
      } else {
        // Targeted flush: deliver entries for this session only.
        while (this.#globalOrder.length > 0) {
          if (!isIdle(this.#sessionStatuses.get(sessionID))) break;

          const idx = this.#globalOrder.findIndex(
            (k) => this.#pending.get(k)?.req.sessionID === sessionID,
          );
          if (idx === -1) break;

          const key = this.#globalOrder[idx]!;
          const entry = this.#pending.get(key);
          if (!entry) {
            this.#globalOrder.splice(idx, 1);
            continue;
          }

          let ok: boolean;
          try {
            ok = this.onDelivery(this.#requestForDelivery(entry));
          } catch {
            ok = false;
          }
          this.#pending.delete(key);
          this.#globalOrder.splice(idx, 1);
          this.byteSize -= entry.byteSize;
          if (!ok) break;
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  /** Shift one entry from the head of the global order, deliver it, and
   * remove it from the pending map. Returns true if the delivery succeeded. */
  #shiftAndDeliver(): boolean {
    const key = this.#globalOrder.shift()!;
    const entry = this.#pending.get(key);
    if (!entry) return true;

    let ok: boolean;
    try {
      ok = this.onDelivery(this.#requestForDelivery(entry));
    } catch {
      ok = false;
    }
    this.#pending.delete(key);
    this.byteSize -= entry.byteSize;
    return ok;
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

  #coalescedKey(req: AutoSubmitRequest): string {
    return `${req.sessionID}::${req.jobID}`;
  }

  #standardKey(req: AutoSubmitRequest): string {
    this.#nextEntryID += 1;
    return `${req.sessionID}::${req.jobID}::${this.#nextEntryID}`;
  }

  #enqueueLoop(req: AutoSubmitRequest, byteSize: number): void {
    const key = this.#coalescedKey(req);
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
    this.#applyCaps();
    this.#pending.set(key, entry);
    this.#globalOrder.push(key);
    this.byteSize += byteSize;
  }

  #enqueueStandard(req: AutoSubmitRequest, byteSize: number): void {
    const key = this.#standardKey(req);
    const entry: IdlePendingEntry = { req, byteSize };
    this.#applyCaps();

    // Per-job cap: check count for this specific job before enqueueing
    const jobEntries = this.#countJobEntries(req.sessionID, req.jobID);
    if (jobEntries >= MAX_PENDING_PER_JOB) {
      this.#evictOldestForJob(req.sessionID, req.jobID);
    }

    this.#pending.set(key, entry);
    this.#globalOrder.push(key);
    this.byteSize += byteSize;
  }

  #applyCaps(): void {
    // Global cap
    while (this.#pending.size >= MAX_PENDING_GLOBAL) {
      this.#evictFifo();
    }
    // Byte cap
    while (this.byteSize >= MAX_QUEUE_BYTES_TOTAL) {
      this.#evictFifo();
    }
  }

  #countJobEntries(sessionID: string, jobID: string): number {
    let count = 0;
    for (const [, entry] of this.#pending) {
      if (entry.req.sessionID === sessionID && entry.req.jobID === jobID) count += 1;
    }
    return count;
  }

  /**
   * Evict the oldest non-coalesced entry using index-based splice
   * to avoid mutation-while-iterating bugs.
   */
  #evictFifo(): void {
    const idx = this.#globalOrder.findIndex((key) => {
      const entry = this.#pending.get(key);
      return entry !== undefined && !entry.coalesced;
    });
    if (idx === -1) return;

    const key = this.#globalOrder[idx];
    const entry = this.#pending.get(key);
    if (!entry) return;

    this.#pending.delete(key);
    this.#globalOrder.splice(idx, 1);
    this.byteSize -= entry.byteSize;
    this.dropped += 1;
  }

  /**
   * Evict the oldest entry for a specific job using findIndex + splice.
   */
  #evictOldestForJob(sessionID: string, jobID: string): void {
    const idx = this.#globalOrder.findIndex((key) => {
      const entry = this.#pending.get(key);
      return entry !== undefined && entry.req.sessionID === sessionID && entry.req.jobID === jobID;
    });
    if (idx === -1) return;

    const key = this.#globalOrder[idx];
    const entry = this.#pending.get(key);
    if (!entry) return;

    this.#pending.delete(key);
    this.#globalOrder.splice(idx, 1);
    this.byteSize -= entry.byteSize;
    this.dropped += 1;
  }

  #measureBytes(req: AutoSubmitRequest): number {
    return new TextEncoder().encode(req.text).length;
  }

  #requestForDelivery(entry: IdlePendingEntry): AutoSubmitRequest {
    const count = entry.coalescedTickCount ?? 1;
    if (!entry.coalesced || count <= 1) return entry.req;
    return {
      ...entry.req,
      text: `${entry.req.text}\n\n[coalesced ${count} loop ticks while session was busy]`,
    };
  }
}

export default IdleQueue;
