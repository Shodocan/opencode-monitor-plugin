import type { AutoSubmitRequest } from '../types.js';
import { BRIDGE_UNAVAILABLE_EXPIRY_MS } from '../limits.js';
import { dedupKey, isDedupEligible } from './dedup.js';
import { monitorDebug } from '../debug-log.js';

// ----------------------------------------------------------------
// Pending entry in the delivery queue (bridge-unavailable)
// ----------------------------------------------------------------

export interface DeliveryPendingEntry {
  req: AutoSubmitRequest;
  enqueuedAt: number;
}

// ----------------------------------------------------------------
// DeliveryQueue
// ----------------------------------------------------------------

/**
 * Queue that bridges when the MCP bridge is unavailable.
 *
 * Entries expire after BRIDGE_UNAVAILABLE_EXPIRY_MS (10 minutes).
 * Idle queue entries do NOT expire just because the session remains
 * busy — only this separate bridge-unavailable queue has a TTL.
 */
export class DeliveryQueue {
  #pending: DeliveryPendingEntry[] = [];
  #dropped = 0;
  #dedupKeys: Set<string> = new Set();
  #deduped = 0;

  get length(): number {
    return this.#pending.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get deduped(): number {
    return this.#deduped;
  }

  // -- Enqueue --------------------------------------------------

  /**
   * Queue a request for later bridge delivery with 10-minute expiry.
   * Expired entries are pruned before the new entry is added.
   */
  enqueue(req: AutoSubmitRequest): void {
    this.#pruneExpired();
    if (isDedupEligible(req.kind)) {
      const dk = dedupKey(req);
      if (this.#dedupKeys.has(dk)) {
        this.#deduped += 1;
        this.#dropped += 1;
        monitorDebug('deliveryQueue.dedup', { sessionID: req.sessionID, jobID: req.jobID, kind: req.kind });
        return;
      }
      this.#dedupKeys.add(dk);
    }
    this.#pending.push({
      req,
      enqueuedAt: Date.now(),
    });
  }

  /**
   * Return the oldest pending requests in FIFO order without removing them.
   */
  peek(n = this.#pending.length): AutoSubmitRequest[] {
    return this.#pending.slice(0, n).map((e) => e.req);
  }

  // -- Dequeue --------------------------------------------------

  /** Pop all pending entries in FIFO order and clear the queue. */
  drain(): AutoSubmitRequest[] {
    const drained: AutoSubmitRequest[] = [];
    for (const entry of this.#pending) {
      drained.push(entry.req);
    }
    this.#pending.length = 0;
    this.#dedupKeys.clear();
    return drained;
  }

  // -- Expiry -------------------------------------------------

  #pruneExpired(): number {
    const now = Date.now();
    const expiry = BRIDGE_UNAVAILABLE_EXPIRY_MS;
    let pruned = 0;
    const remaining: DeliveryPendingEntry[] = [];

    for (const entry of this.#pending) {
      if (now - entry.enqueuedAt >= expiry) {
        if (isDedupEligible(entry.req.kind)) {
          this.#dedupKeys.delete(dedupKey(entry.req));
        }
        this.#dropped += 1;
        pruned += 1;
      } else {
        remaining.push(entry);
      }
    }

    this.#pending = remaining;
    return pruned;
  }

  /**
   * Return the count of entries that will expire within the next `ms` window.
   */
  expiredWithin(ms: number): number {
    const cutoff = Date.now() - (BRIDGE_UNAVAILABLE_EXPIRY_MS - ms);
    let count = 0;
    for (const entry of this.#pending) {
      if (entry.enqueuedAt <= cutoff) count += 1;
    }
    return count;
  }

  /**
   * Flush (deliver) all pending entries through the synchronous handler.
   * Returns count of successfully delivered requests.
   * Exceptions from `onDelivery` are caught and do not leave the queue stuck.
   */
  flush(
    onDelivery: (req: AutoSubmitRequest) => void | boolean,
  ): number {
    let delivered = 0;
    const remaining: DeliveryPendingEntry[] = [];

    for (const entry of this.#pending) {
      try {
        const ok = onDelivery(entry.req);
        if (ok !== false) {
          delivered += 1;
        } else {
          remaining.push(entry);
        }
      } catch {
        // Handler threw — continue delivering remaining entries
        // so a single exception does not deadlock the queue.
        remaining.push(entry);
      }
    }

    this.#pending = remaining;
    this.#dedupKeys.clear();
    return delivered;
  }
}

export default DeliveryQueue;
