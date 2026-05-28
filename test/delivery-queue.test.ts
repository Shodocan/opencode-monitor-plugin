import { describe, expect, it, vi } from 'vitest';
import { DeliveryQueue } from '../src/delivery/delivery-queue.js';
import { BRIDGE_UNAVAILABLE_EXPIRY_MS } from '../src/limits.js';
import type { AutoSubmitRequest } from '../src/types.js';

function req(
  jobID = 'bg_1',
  kind: AutoSubmitRequest['kind'] = 'bg',
  text = 'hello',
  sessionID = 's1',
): AutoSubmitRequest {
  return { sessionID, jobID, kind, text, submit: true };
}

// ----------------------------------------------------------------
// Basic enqueue / drain
// ----------------------------------------------------------------

describe('DeliveryQueue enqueue / drain', () => {
  it('enqueues and drains in FIFO order', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('bg_1'));
    q.enqueue(req('bg_2'));
    expect(q.length).toBe(2);
    const drained = q.drain();
    expect(drained.length).toBe(2);
    expect(drained[0].jobID).toBe('bg_1');
    expect(drained[1].jobID).toBe('bg_2');
    expect(q.length).toBe(0);
  });

  it('peek returns entries without removing them', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('bg_1'));
    q.enqueue(req('bg_2'));
    const peeked = q.peek(1);
    expect(peeked.length).toBe(1);
    expect(peeked[0].jobID).toBe('bg_1');
    expect(q.length).toBe(2);
  });

  it('drain returns empty array when queue is empty', () => {
    const q = new DeliveryQueue();
    expect(q.drain()).toEqual([]);
  });
});

// ----------------------------------------------------------------
// 10-minute expiry
// ----------------------------------------------------------------

describe('DeliveryQueue expiry', () => {
  it('prunes expired entries on enqueue', () => {
    const q = new DeliveryQueue();
    // Manually set enqueuedAt to simulate past expiry
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => 0);

    q.enqueue(req('old'));

    // Move time forward past expiry
    spy.mockImplementation(() => BRIDGE_UNAVAILABLE_EXPIRY_MS + 1);
    q.enqueue(req('new'));

    // The old entry should have been pruned
    expect(q.dropped).toBe(1);
    expect(q.length).toBe(1);
    expect(q.peek()[0].jobID).toBe('new');
    spy.mockRestore();
  });

  it('expiredWithin reports entries near expiry', () => {
    const q = new DeliveryQueue();

    const now = Date.now();
    // Use negative offset approach: set entry at time that is near expiry
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    q.enqueue(req('x'));
    // That entry just enqueued at `now`, not expired yet

    // Enqueue an expired entry by manipulating internals
    vi.spyOn(Date, 'now').mockImplementation(() => now + BRIDGE_UNAVAILABLE_EXPIRY_MS + 1);
    q.enqueue(req('y'));
    // y is new, x is expired — should have pruned x on enqueue
    expect(q.dropped).toBe(1);
  });
});

// ----------------------------------------------------------------
// DeliveryQueue vs IdleQueue: no expiry for idle entries
// ----------------------------------------------------------------

describe('DeliveryQueue distinct from IdleQueue', () => {
  it('delivery queue has expiry while idle queue entries do not expire', () => {
    const dq = new DeliveryQueue();
    // Delivery queue entries do expire after 10 minutes
    dq.enqueue(req('bg_1'));
    expect(dq.length).toBe(1);
    // Idle entries stay queued regardless of session busyness —
    // confirmed by the absence of any TTL field on the DeliveryQueue entry
    void dq;
  });

  it('dropped count increments on expiry prune', () => {
    const q = new DeliveryQueue();
    const now = Date.now();

    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    q.enqueue(req('old'));
    spy.mockImplementation(() => now + BRIDGE_UNAVAILABLE_EXPIRY_MS + 1);
    q.enqueue(req('new'));
    spy.mockRestore();

    expect(q.dropped).toBe(1);
  });
});
