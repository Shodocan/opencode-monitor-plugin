import type { AutoSubmitRequest } from '../types.js';
import { BRIDGE_UNAVAILABLE_EXPIRY_MS } from '../limits.js';

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

  get length(): number {
    return this.#pending.length;
  }

  get dropped(): number {
    return this.#dropped;
  }

  // -- Enqueue --------------------------------------------------

  /**
   * Queue a request for later bridge delivery with 10-minute expiry.
   * Expired entries are pruned before the new entry is added.
   */
  enqueue(req: AutoSubmitRequest): void {
    this.#pruneExpired();
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
}

export default DeliveryQueue;
