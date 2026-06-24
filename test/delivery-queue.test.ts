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
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => 0);

    q.enqueue(req('old'));

    // Move time forward past expiry
    spy.mockImplementation(() => BRIDGE_UNAVAILABLE_EXPIRY_MS + 1);
    q.enqueue(req('new'));

    expect(q.dropped).toBe(1);
    expect(q.length).toBe(1);
    expect(q.peek()[0].jobID).toBe('new');
    spy.mockRestore();
  });

  it('expiredWithin reports entries near expiry', () => {
    const base = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => base);

    const q = new DeliveryQueue();
    // Enqueue when "now" is near-bridge-expiry age
    const nearExpiryMs = 1000; // will expire in ~1s
    const enqueuedAt = base - (BRIDGE_UNAVAILABLE_EXPIRY_MS - nearExpiryMs);
    spy.mockImplementation(() => enqueuedAt);
    q.enqueue(req('near-expiry'));

    // Now time is `base` — entry is near expiry
    spy.mockImplementation(() => base);

    // Entries expiring within 2000ms should be counted
    const count = q.expiredWithin(2000);
    expect(count).toBe(1);
    spy.mockRestore();
  });

  it('expiredWithin returns 0 for fresh entries', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('fresh'));
    // Fresh entry just enqueued, not near expiry
    const count = q.expiredWithin(1000);
    expect(count).toBe(0);
  });
});

// ----------------------------------------------------------------
// DeliveryQueue vs IdleQueue: no expiry for idle entries
// ----------------------------------------------------------------

describe('DeliveryQueue distinct from IdleQueue', () => {
  it('delivery queue has expiry while idle queue entries do not expire', () => {
    const dq = new DeliveryQueue();
    dq.enqueue(req('bg_1'));
    expect(dq.length).toBe(1);
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

// ----------------------------------------------------------------
// flush with try/finally — handler exceptions do not deadlock
// ----------------------------------------------------------------

describe('DeliveryQueue flush', () => {
  it('flush delivers all entries when handler returns true', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('a'));
    q.enqueue(req('b'));

    let delivered = 0;
    const count = q.flush(() => {
      delivered += 1;
      return true;
    });

    expect(count).toBe(2);
    expect(delivered).toBe(2);
    expect(q.length).toBe(0);
  });

  it('flush stops on false return', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('a'));
    q.enqueue(req('b'));
    q.enqueue(req('c'));

    let callCount = 0;
    const count = q.flush(() => {
      callCount += 1;
      return callCount <= 1; // allow first, reject second
    });

    expect(count).toBe(1);
    expect(q.length).toBe(2);
  });

  it('handler exception does not leave flush stuck', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('throws'));
    q.enqueue(req('ok'));

    let callCount = 0;
    const count = q.flush(() => {
      callCount += 1;
      if (callCount === 1) throw new Error('bridge error');
      return true;
    });

    // First threw (retained), second delivered
    expect(count).toBe(1);
    // Thrown entry retained in queue
    expect(q.length).toBe(1);
    // Queue is not deadlocked — can flush again
    const count2 = q.flush(() => true);
    expect(count2).toBe(1);
    expect(q.length).toBe(0);
  });
});

// ----------------------------------------------------------------
// No direct mutation of implementation details
// ----------------------------------------------------------------

describe('DeliveryQueue no direct mutation leak', () => {
  it('peek returns independent copy', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('x'));
    q.enqueue(req('y'));

    const a = q.peek();
    const b = q.peek();
    expect(a).not.toBe(b);

    // Mutate returned array — should not affect internal state
    a.length = 0;
    expect(q.length).toBe(2);
  });

  it('drain clears the queue completely', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('a'));
    q.enqueue(req('b'));
    q.drain();
    expect(q.length).toBe(0);
    expect(q.drain()).toEqual([]);
  });
});

// ----------------------------------------------------------------
// Content dedup
// ----------------------------------------------------------------

describe('DeliveryQueue content dedup', () => {
  it('drops duplicate eligible payloads and counts them', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'window'));
    q.enqueue(req('mon_1', 'mon', 'window'));
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
    expect(q.deduped).toBe(2);
    expect(q.dropped).toBe(2);
  });

  it('keeps distinct payloads separate', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'a'));
    q.enqueue(req('mon_1', 'mon', 'b'));
    expect(q.length).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('does not dedup loop entries', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('loop_1', 'loop', 'tick'));
    q.enqueue(req('loop_1', 'loop', 'tick'));
    expect(q.length).toBe(2);
    expect(q.deduped).toBe(0);
  });

  it('accepts the same payload again after drain clears the key', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'window'));
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
    q.drain();
    expect(q.length).toBe(0);
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
    expect(q.deduped).toBe(1);
  });

  it('accepts the same payload again after flush clears the key', () => {
    const q = new DeliveryQueue();
    q.enqueue(req('mon_1', 'mon', 'window'));
    let count = 0;
    q.flush(() => {
      count += 1;
      return true;
    });
    expect(count).toBe(1);
    q.enqueue(req('mon_1', 'mon', 'window'));
    expect(q.length).toBe(1);
  });

  it('clears dedupKey when an expired entry is pruned', () => {
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => 0);
    const q = new DeliveryQueue();
    q.enqueue(req('old', 'mon', 'window'));
    spy.mockImplementation(() => BRIDGE_UNAVAILABLE_EXPIRY_MS + 1);
    q.enqueue(req('new', 'mon', 'other'));
    q.enqueue(req('old', 'mon', 'window'));
    expect(q.length).toBe(2);
    spy.mockRestore();
  });
});
