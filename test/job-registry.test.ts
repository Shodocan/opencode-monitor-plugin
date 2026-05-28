import { describe, expect, it } from 'vitest';
import { JobRegistry } from '../src/registry/job-registry.js';
import type { JobKind } from '../src/types.js';

describe('JobRegistry', () => {
  function mk(kind: JobKind = 'bg'): [JobRegistry, string] {
    const reg = new JobRegistry('test-session-abc');
    const jobID = reg.register(kind);
    return [reg, jobID];
  }

  // -- ID generation ---------------------------------------------

  it('generates IDs as {kind}_{global_monotonic_counter}', () => {
    const reg = new JobRegistry('sess');
    expect(reg.register('bg')).toBe('bg_1');
    expect(reg.register('mon')).toBe('mon_2');
    expect(reg.register('bg')).toBe('bg_3');
  });

  it('increments counter independently per registry instance', () => {
    const a = new JobRegistry('a');
    const b = new JobRegistry('b');
    expect(a.register('bg')).toBe('bg_1');
    expect(b.register('bg')).toBe('bg_1');
  });

  it('supports all four JobKind values', () => {
    const reg = new JobRegistry('s');
    for (const kind of ['bg', 'mon', 'loop', 'sched'] as JobKind[]) {
      expect(reg.register(kind)).toMatch(new RegExp(`^${kind}_\\d+$`));
    }
  });

  // -- sessionRef -------------------------------------------------

  it('exposes sessionRef derived from sessionID', () => {
    const reg = new JobRegistry('test-session-abc');
    expect(typeof reg.sessionRef).toBe('string');
    expect(reg.sessionRef.length).toBeGreaterThan(0);
    // Deterministic: same sessionID → same ref
    expect(new JobRegistry('test-session-abc').sessionRef).toBe(reg.sessionRef);
  });

  // -- list / get --------------------------------------------------

  it('returns registered jobs from list()', () => {
    const reg = new JobRegistry('s');
    const id1 = reg.register('bg');
    const id2 = reg.register('mon');
    const list = reg.list();
    expect(list).toHaveLength(2);
    const ids = list.map((j) => j.jobID);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('get() returns JobStatus for active job', () => {
    const [reg, jobID] = mk('loop');
    const status = reg.get(jobID);
    expect(status).toBeDefined();
    expect(status?.kind).toBe('loop');
    expect(status?.status).toBe('active');
    expect(status?.deliveryStatus).toBe('pending');
    expect(status?.queueDroppedCount).toBe(0);
  });

  it('get() returns undefined for unknown ID', () => {
    const [reg] = mk();
    expect(reg.get('nonexistent_99')).toBeUndefined();
  });

  // -- cancel -----------------------------------------------------

  it('cancels an active job', () => {
    const [reg, jobID] = mk('mon');
    reg.cancel(jobID);
    const status = reg.get(jobID);
    expect(status?.status).toBe('cancelled');
    expect(reg.activeCount).toBe(0);
  });

  it('throws "not found" for unknown jobID', () => {
    const [reg] = mk();
    expect(() => reg.cancel('ghost_0')).toThrow('job ghost_0 not found.');
  });

  it('throws "cannot be cancelled" for already-cancelled job', () => {
    const [reg, jobID] = mk();
    reg.cancel(jobID);
    expect(() => reg.cancel(jobID)).toThrow(`job ${jobID} cannot be cancelled (status: cancelled).`);
  });

  it('throws "not found" for never-registered job', () => {
    const reg = new JobRegistry('s');
    expect(() => reg.cancel('bg_0')).toThrow('job bg_0 not found.');
  });

  // -- active limit ------------------------------------------------

  it('rejects registration beyond MAX_ACTIVE_JOBS', () => {
    const reg = new JobRegistry('s');
    for (let i = 0; i < 20; i++) reg.register('bg');
    expect(reg.activeCount).toBe(20);
    expect(() => reg.register('bg')).toThrow('max active jobs (20)');
  });

  it('allows new registration after cancelling one', () => {
    const reg = new JobRegistry('s');
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(reg.register('bg'));
    reg.cancel(ids[0]);
    expect(reg.activeCount).toBe(19);
    const newId = reg.register('mon');
    expect(newId).toBeDefined();
    expect(reg.activeCount).toBe(20);
  });

  // -- completed retention -----------------------------------------

  it('trims completed list to MAX_COMPLETED_RETENTION', () => {
    const reg = new JobRegistry('s');
    for (let i = 0; i < 55; i++) {
      const id = reg.register('bg');
      reg.cancel(id);
    }
    // Active should be 0, completed capped at 50
    expect(reg.activeCount).toBe(0);
    // List includes active + completed
    expect(reg.list()).toHaveLength(50);
  });

  // -- delivery status update ------------------------------------

  it('updates deliveryStatus on an active job', () => {
    const [reg, jobID] = mk();
    reg.updateDeliveryStatus(jobID, 'sent');
    expect(reg.get(jobID)?.deliveryStatus).toBe('sent');
  });

  it('updates deliveryStatus on a completed job', () => {
    const [reg, jobID] = mk();
    reg.cancel(jobID);
    reg.updateDeliveryStatus(jobID, 'bridge_failed');
    expect(reg.get(jobID)?.deliveryStatus).toBe('bridge_failed');
  });

  it('throws "not found" for deliveryStatus update on unknown job', () => {
    const [reg] = mk();
    expect(() => reg.updateDeliveryStatus('unknown_0', 'sent')).toThrow('job unknown_0 not found.');
  });

  // -- queueDroppedCount ------------------------------------------

  it('increments queueDroppedCount by 1 by default', () => {
    const [reg, jobID] = mk();
    reg.incrementQueueDropped(jobID);
    reg.incrementQueueDropped(jobID);
    expect(reg.get(jobID)?.queueDroppedCount).toBe(2);
  });

  it('increments queueDroppedCount by custom amount', () => {
    const [reg, jobID] = mk();
    reg.incrementQueueDropped(jobID, 5);
    expect(reg.get(jobID)?.queueDroppedCount).toBe(5);
  });

  it('increments on a cancelled job', () => {
    const [reg, jobID] = mk();
    reg.cancel(jobID);
    reg.incrementQueueDropped(jobID);
    expect(reg.get(jobID)?.queueDroppedCount).toBe(1);
  });

  it('throws "not found" for incrementQueueDropped on unknown job', () => {
    const [reg] = mk();
    expect(() => reg.incrementQueueDropped('ghost_0')).toThrow('job ghost_0 not found.');
  });

  // -- complete / fail transition ----------------------------------

  it('transitions to completed via complete()', () => {
    const [reg, jobID] = mk();
    reg.complete(jobID);
    expect(reg.get(jobID)?.status).toBe('completed');
    expect(reg.activeCount).toBe(0);
  });

  it('transitions to failed with optional fields', () => {
    const [reg, jobID] = mk();
    reg.fail(jobID, 'bridge_failed', 3);
    const s = reg.get(jobID);
    expect(s?.status).toBe('failed');
    expect(s?.deliveryStatus).toBe('bridge_failed');
    expect(s?.queueDroppedCount).toBe(3);
    expect(reg.activeCount).toBe(0);
  });

  // -- activeCount ------------------------------------------------

  it('tracks active count accurately', () => {
    const reg = new JobRegistry('s');
    expect(reg.activeCount).toBe(0);
    reg.register('bg');
    expect(reg.activeCount).toBe(1);
    reg.register('mon');
    expect(reg.activeCount).toBe(2);
    const ids = [reg.register('loop'), reg.register('sched')];
    expect(reg.activeCount).toBe(4);
    reg.cancel(ids[0]);
    reg.fail(ids[1]);
    expect(reg.activeCount).toBe(2);
  });
});
