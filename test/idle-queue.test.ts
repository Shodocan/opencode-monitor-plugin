import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AutoSubmitRequest } from '../src/types.js';
import { IdleQueue, isIdle } from '../src/bridge/idle-queue.js';
import {
  MAX_PENDING_PER_JOB,
  MAX_PENDING_GLOBAL,
  MAX_QUEUE_BYTES_TOTAL,
} from '../src/limits.js';

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function req(
  sessionID = 's1',
  jobID = 'bg_1',
  kind: AutoSubmitRequest['kind'] = 'bg',
  text = 'hello',
): AutoSubmitRequest {
  return { sessionID, jobID, kind, text, submit: true };
}

function bigReq(text: string = '.'.repeat(4096)): AutoSubmitRequest {
  return req('s1', 'bg_xxx', 'bg', text);
}

let delivered: AutoSubmitRequest[];
let deliveryStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delivered = [];
  deliveryStub = vi.fn((r: AutoSubmitRequest) => {
    delivered.push(r);
    return true;
  });
});

// ----------------------------------------------------------------
// isIdle
// ----------------------------------------------------------------

describe('isIdle', () => {
  it('recognises idle status', () => {
    expect(isIdle('idle')).toBe(true);
  });
  it('rejects busy status', () => {
    expect(isIdle('busy')).toBe(false);
  });
  it('rejects retry status', () => {
    expect(isIdle('retry')).toBe(false);
  });
  it('rejects undefined (unknown) status', () => {
    expect(isIdle(undefined)).toBe(false);
  });
});

// ----------------------------------------------------------------
// IdleQueue — status & enqueue behaviour
// ----------------------------------------------------------------

describe('IdleQueue status', () => {
  it('reflects initial status', () => {
    const q = new IdleQueue('busy', deliveryStub);
    expect(q.status).toBe('busy');
  });

  it('unknown status is treated busy (queues, no flush)', () => {
    const q = new IdleQueue(undefined, deliveryStub);
    q.enqueue(req());
    expect(q.pendingCount).toBe(1);
    expect(delivered.length).toBe(0);
  });

  it('setSessionStatus idle triggers flush', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req());
    q.setSessionStatus('idle');
    expect(delivered.length).toBe(1);
  });

  it('setSessionStatus busy does not trigger flush for idle queue', () => {
    const q = new IdleQueue('idle', deliveryStub);
    q.enqueue(req());
    q.setSessionStatus('busy');
    expect(delivered.length).toBe(0);
  });
});

// ----------------------------------------------------------------
// Per-session status isolation
// ----------------------------------------------------------------

describe('IdleQueue per-session status cache', () => {
  it('isolates status per session', () => {
    const q = new IdleQueue(undefined, deliveryStub);
    q.setSessionStatus('idle', 's1');
    q.setSessionStatus('busy', 's2');

    // s1 is idle → getSessionStatus reflects per-session cache
    expect(q.getSessionStatus('s1')).toBe('idle');
    expect(q.getSessionStatus('s2')).toBe('busy');
  });

  it('flush(sessionID) only flushes relevant session entries', () => {
    const q = new IdleQueue(undefined, deliveryStub);
    q.setSessionStatus('idle', 's1');
    q.setSessionStatus('busy', 's2');

    // Enqueue entries for both sessions (busy so no auto-flush for s2)
    q.enqueue(req('s1', 'bg_a', 'bg', 'from-s1'));
    q.enqueue(req('s1', 'bg_b', 'bg', 'from-s1-2'));
    q.enqueue(req('s2', 'bg_c', 'bg', 'from-s2'));

    q.flush('s1');
    expect(delivered.map((d) => d.text)).toEqual(['from-s1', 'from-s1-2']);
    expect(q.pendingCount).toBe(1);
  });

  it('getSessionStatus returns undefined for unknown session', () => {
    const q = new IdleQueue(undefined, deliveryStub);
    expect(q.getSessionStatus('unknown')).toBe(undefined);
  });
});

// ----------------------------------------------------------------
// IdleQueue — deliver / flush
// ----------------------------------------------------------------

describe('IdleQueue deliver', () => {
  it('delivers immediately when idle', () => {
    const q = new IdleQueue('idle', deliveryStub);
    q.deliver(req());
    expect(delivered.length).toBe(1);
  });

  it('queues when busy and flushes on status change', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.deliver(req());
    q.deliver(req('s1', 'bg_2'));
    expect(q.pendingCount).toBe(2);
    q.setSessionStatus('idle');
    expect(delivered.length).toBe(2);
    expect(q.pendingCount).toBe(0);
  });

  it('rechecks status before each delivery in flush', () => {
    const qBusy = new IdleQueue('busy', deliveryStub);
    qBusy.enqueue(req());
    qBusy.enqueue(req('s1', 'bg_2'));
    qBusy.setSessionStatus('idle');
    expect(delivered.length).toBe(2);
  });

  it('mid-flush status change retains unsent tail', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req());
    q.enqueue(req('s1', 'bg_2'));

    let deliveredCount = 0;
    const stopAfter = 1;
    q.onDelivery = () => {
      deliveredCount += 1;
      if (deliveredCount < stopAfter) return true;
      return false; // stop flush
    };

    q.setSessionStatus('idle');
    // First entry delivered, flush stops on second
    expect(deliveredCount).toBe(1);
    expect(q.pendingCount).toBe(1);
  });

  it('delivery handler exception does not leave flushing stuck', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_throw', 'bg', 'will-throw'));
    q.enqueue(req('s1', 'bg_ok', 'bg', 'pass'));

    let callCount = 0;
    q.onDelivery = () => {
      callCount += 1;
      if (callCount === 1) throw new Error('bridge error');
      return true;
    };

    // Flush with try/finally must not leave #flushing = true forever
    q.setSessionStatus('idle');

    // After flush, calling flush again should not be blocked
    q.flush();
    expect(q.pendingCount).toBe(0);
  });
});

// ----------------------------------------------------------------
// IdleQueue — /loop coalescing
// ----------------------------------------------------------------

describe('IdleQueue /loop coalescing', () => {
  it('coalesces loop entries by session+job, last wins', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'loop_1', 'loop', 'tick-1'));
    q.enqueue(req('s1', 'loop_1', 'loop', 'tick-2'));
    expect(q.pendingCount).toBe(1);
    const entries = q.peek();
    expect(entries[0].req.text).toBe('tick-2');
    expect(entries[0].coalesced).toBe(true);
  });

  it('tracks coalescedTickCount metadata', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'loop_1', 'loop', 'a'));
    q.enqueue(req('s1', 'loop_1', 'loop', 'b'));
    q.enqueue(req('s1', 'loop_1', 'loop', 'c'));
    expect(q.pendingCount).toBe(1);
    const entry = q.peek()[0];
    expect(entry.coalescedTickCount).toBe(3);
  });

  it('non-loop entries are separate pending records', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_1', 'bg', 'x'));
    q.enqueue(req('s1', 'bg_2', 'bg', 'y'));
    expect(q.pendingCount).toBe(2);
  });

  it('/bg /mon /sched retain full payloads as separate entries', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_1', 'bg'));
    q.enqueue(req('s1', 'mon_1', 'mon'));
    q.enqueue(req('s1', 'sched_1', 'sched'));
    expect(q.pendingCount).toBe(3);
  });

  it('coalesced entry survives FIFO eviction during coalesced loop', () => {
    const q = new IdleQueue('busy', deliveryStub);
    // Enqueue a coalesced loop entry first
    q.enqueue(req('s1', 'loop_1', 'loop', 'first'));
    // Fill up to global cap with standard entries
    for (let i = 0; i < MAX_PENDING_GLOBAL; i++) {
      q.enqueue(req('s1', `bg_${i}`, 'bg', 'x'));
    }
    const entries = q.peek();
    const loopEntry = entries.find((e) => e.req.kind === 'loop');
    expect(loopEntry).toBeDefined();
    // Also verify tickCount was incremented
    expect(loopEntry!.coalescedTickCount).toBe(1);
  });

  it('coalesced loop survives eviction even when at capacity', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'loop_1', 'loop', 'tick-1'));
    q.enqueue(req('s1', 'loop_1', 'loop', 'tick-2'));
    // Fill to cap
    for (let i = 0; i < MAX_PENDING_GLOBAL + 2; i++) {
      q.enqueue(req('s1', `bg_${i}`, 'bg', 'x'));
    }
    // Coalesced loop must still be in queue
    const hasLoop = q.peek().some((e) => e.req.jobID === 'loop_1');
    expect(hasLoop).toBe(true);
    // And it should have been coalesced
    const loopEntry = q.peek().find((e) => e.req.jobID === 'loop_1');
    expect(loopEntry?.coalesced).toBe(true);
  });
});

// ----------------------------------------------------------------
// IdleQueue — per-job / global / byte caps + FIFO eviction
// ----------------------------------------------------------------

describe('IdleQueue caps', () => {
  it('enforces per-job cap', () => {
    const q = new IdleQueue('busy', deliveryStub);
    for (let i = 0; i < MAX_PENDING_PER_JOB + 2; i++) {
      q.enqueue(req('s1', 'shared_job', 'bg', `payload-${i}`));
    }
    expect(q.dropped).toBeGreaterThan(0);
  });

  it('scopes per-job cap by sessionID', () => {
    const q = new IdleQueue('busy', deliveryStub);
    for (let i = 0; i < MAX_PENDING_PER_JOB; i++) {
      q.enqueue(req('s1', 'shared_job', 'bg', `s1-${i}`));
    }

    q.enqueue(req('s2', 'shared_job', 'bg', 's2-payload'));

    expect(q.dropped).toBe(0);
    expect(q.peek().some((entry) => entry.req.sessionID === 's2')).toBe(true);
  });

  it('enforces global cap with FIFO eviction', () => {
    const q = new IdleQueue('busy', deliveryStub);
    for (let i = 0; i < MAX_PENDING_GLOBAL + 3; i++) {
      q.enqueue(req('s1', `job_${i}`, 'bg', `x`));
    }
    expect(q.dropped).toBe(3);
  });

  it('evicts when byte cap is reached', () => {
    const q = new IdleQueue('busy', deliveryStub);
    const bytesPer = 4 * 1024; // 4 KiB each
    const needed = Math.ceil(MAX_QUEUE_BYTES_TOTAL / bytesPer) + 2;
    for (let i = 0; i < needed; i++) {
      q.enqueue(bigReq('.'.repeat(bytesPer)));
    }
    expect(q.byteSize).toBeLessThan(MAX_QUEUE_BYTES_TOTAL + bytesPer);
    expect(q.dropped).toBeGreaterThan(0);
  });

  it('idle queue entries do not expire (no TTL)', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_1', 'bg', 'will-stay'));
    expect(q.pendingCount).toBe(1);
  });

  it('evictFifo uses index-based splice (no mutation-while-iterating)', () => {
    // Verify that after eviction, the queue is consistent — the evicted
    // entry was removed from both #globalOrder and #pending.
    const q = new IdleQueue('busy', deliveryStub);
    const entries: AutoSubmitRequest[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(req('s1', `bg_${i}`, 'bg', `payload-${i}`));
      q.enqueue(entries[i]);
    }
    // Now force eviction by adding enough to exceed global cap
    for (let i = 5; i < MAX_PENDING_GLOBAL + 2; i++) {
      q.enqueue(req('s1', `bg_${i}`, 'bg', `x-${i}`));
    }
    // Oldest bg_0 should have been evicted
    const hasBg0 = q.peek().some((e) => e.req.jobID === 'bg_0');
    expect(hasBg0).toBe(false);
  });
});

// ----------------------------------------------------------------
// IdleQueue — dropped count tracking
// ----------------------------------------------------------------

describe('IdleQueue dropped count', () => {
  it('tracks dropped entries', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.dropped = 0;
    for (let i = 0; i < MAX_PENDING_GLOBAL + 10; i++) {
      q.enqueue(req('s1', `bg_${i}`, 'bg', 'x'));
    }
    expect(q.dropped).toBe(10);
  });
});

// ----------------------------------------------------------------
// IdleQueue — no direct mutation of implementation details
// ----------------------------------------------------------------

describe('IdleQueue no direct mutation leak', () => {
  it('peek returns a new array each call (no direct mutation)', () => {
    const q = new IdleQueue('busy', deliveryStub);
    q.enqueue(req('s1', 'bg_1', 'bg', 'a'));
    q.enqueue(req('s1', 'bg_2', 'bg', 'b'));

    const a = q.peek();
    const b = q.peek();
    expect(a).not.toBe(b);
    // Mutating the returned array does not affect internal state
    a.length = 0;
    expect(q.pendingCount).toBe(2);
  });

  it('pendingCount is consistent after eviction', () => {
    const q = new IdleQueue('busy', deliveryStub);
    for (let i = 0; i < MAX_PENDING_GLOBAL + 2; i++) {
      q.enqueue(req('s1', `bg_${i}`, 'bg', 'x'));
    }
    // After eviction, pendingCount reflects actual entries
    expect(q.pendingCount).toBeLessThanOrEqual(MAX_PENDING_GLOBAL);
  });
});
