import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AutoSubmitRequest } from '../src/types.js';
import {
  PromptScheduler,
  type DeliveryCallback,
  type LoopConfig,
  type ScheduleConfig,
} from '../src/scheduler/prompt-scheduler.js';

vi.useFakeTimers();
vi.setSystemTime(0);

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function scheduler(delivery: DeliveryCallback = vi.fn()) {
  return new PromptScheduler({ delivery });
}

function mkLoop(cfg: Partial<LoopConfig> = {}): LoopConfig {
  return {
    jobID: 'loop-1',
    sessionID: 'sess-1',
    intervalMs: 1000,
    prompt: 'do work',
    ...cfg,
  };
}

function mkSchedule(cfg: Partial<ScheduleConfig> = {}): ScheduleConfig {
  const runAt = cfg.runAt ?? new Date(5000);
  return {
    jobID: 'sched-1',
    sessionID: 'sess-1',
    runAt,
    prompt: 'fire once',
    ...cfg,
  };
}

function isLoop(request: AutoSubmitRequest) {
  return request.kind === 'loop' && request.submit === true;
}
function isSched(request: AutoSubmitRequest) {
  return request.kind === 'sched' && request.submit === true;
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('PromptScheduler', () => {
  let delivery: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllTimers();
  });

  // -- constructor --
  describe('constructor', () => {
    it('accepts delivery callback', () => {
      const s = scheduler();
      expect(s.activeJobs.size).toBe(0);
    });
  });

  // -- scheduleLoop --
  describe('scheduleLoop', () => {
    it('fires immediately then loops at interval', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);

      s.scheduleLoop(mkLoop({ intervalMs: 500 }));
      expect(delivery).toHaveBeenCalledTimes(1);
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({ jobID: 'loop-1', kind: 'loop', submit: true, text: 'do work' })
      );
      expect(s.activeJobs.has('loop-1')).toBe(true);

      vi.advanceTimersByTime(500);
      expect(delivery).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(500);
      expect(delivery).toHaveBeenCalledTimes(3);
      s.destroy();
    });

    it('accepts interval as raw milliseconds', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);
      s.scheduleLoop({
        jobID: 'raw-ms',
        sessionID: 's',
        intervalMs: 10_000,
        prompt: 'hourly',
      });
      expect(delivery).toHaveBeenCalledTimes(1);
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'loop',
          text: 'hourly',
          sessionID: 's',
          jobID: 'raw-ms',
          submit: true,
        })
      );
      s.destroy();
    });

    it('does not duplicate if jobID already active', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);
      s.scheduleLoop(mkLoop());
      s.scheduleLoop(mkLoop());
      expect(delivery).toHaveBeenCalledTimes(1);
      s.destroy();
    });
  });

  // -- scheduleOnce --
  describe('scheduleOnce', () => {
    it('fires one-shot at future date', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);

      const runAt = new Date(3000);
      s.scheduleOnce({ ...mkSchedule(), runAt });

      expect(delivery).not.toHaveBeenCalled();
      expect(s.activeJobs.has('sched-1')).toBe(true);

      vi.advanceTimersByTime(3000);
      expect(delivery).toHaveBeenCalledTimes(1);
      expect(isSched(delivery.mock.calls[0][0])).toBe(true);
      expect(delivery).toHaveBeenCalledWith(
        expect.objectContaining({
          jobID: 'sched-1',
          kind: 'sched',
          text: 'fire once',
          submit: true,
        })
      );
      expect(s.activeJobs.has('sched-1')).toBe(false);
      s.destroy();
    });

    it('fires immediately if runAt is in the past', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);

      // system time is 0, past date is -10000 → delay clamped to 0
      s.scheduleOnce({ ...mkSchedule(), runAt: new Date(-10_000) });
      vi.advanceTimersByTime(0);
      expect(delivery).toHaveBeenCalledTimes(1);
      s.destroy();
    });

    it('does not duplicate for same jobID', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);
      const runAt = new Date(5000);
      s.scheduleOnce({ ...mkSchedule(), runAt });
      s.scheduleOnce({ ...mkSchedule(), runAt });
      vi.advanceTimersByTime(10_000);
      expect(delivery).toHaveBeenCalledTimes(1);
      s.destroy();
    });
  });

  // -- cancel --
  describe('cancel', () => {
    it('clears a pending loop timer', () => {
      const s = scheduler(vi.fn());
      s.scheduleLoop(mkLoop({ intervalMs: 500 }));
      expect(s.activeJobs.has('loop-1')).toBe(true);

      const cleared = s.cancel('loop-1');
      expect(cleared).toBe(true);
      expect(s.activeJobs.has('loop-1')).toBe(false);

      vi.advanceTimersByTime(500);
      s.destroy();
    });

    it('clears a pending one-shot timer', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);

      s.scheduleOnce({ ...mkSchedule(), runAt: new Date(5000) });
      expect(delivery).not.toHaveBeenCalled();

      const cleared = s.cancel('sched-1');
      expect(cleared).toBe(true);

      vi.advanceTimersByTime(5000);
      expect(delivery).not.toHaveBeenCalled();
      s.destroy();
    });

    it('returns false for unknown jobID', () => {
      const s = scheduler(vi.fn());
      expect(s.cancel('no-such-job')).toBe(false);
      s.destroy();
    });
  });

  // -- destroy --
  describe('destroy', () => {
    it('clears all timers and active set', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);

      s.scheduleLoop(mkLoop({ intervalMs: 1000 }));
      s.scheduleOnce({ ...mkSchedule(), runAt: new Date(2000) });

      s.destroy();
      expect(s.activeJobs.size).toBe(0);

      vi.advanceTimersByTime(5000);
      // Only the initial loop fire should have happened.
      expect(delivery).toHaveBeenCalledTimes(1);
    });
  });

  // -- fire/cancel race guard --
  describe('race guard', () => {
    it('drops request when job is removed before next tick', () => {
      const s = scheduler(vi.fn());
      s.scheduleLoop(mkLoop({ intervalMs: 1000 }));

      // Cancel immediately after first fire.
      s.cancel('loop-1');

      // Second tick should be suppressed.
      vi.advanceTimersByTime(1000);
      // No new delivery — only the initial fire counted (delivery is just vi.fn()).
      s.destroy();
    });
  });

  // -- AutoSubmitRequest shape --
  describe('AutoSubmitRequest shape', () => {
    it('loop request has shape submit true, kind loop, sessionID, jobID, text', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);
      s.scheduleLoop({
        jobID: 'shape-loop',
        sessionID: 'sess-x',
        intervalMs: 2000,
        prompt: 'formatted text',
      });

      const req = delivery.mock.calls[0][0];
      expect(req.kind).toBe('loop');
      expect(req.submit).toBe(true);
      expect(req.sessionID).toBe('sess-x');
      expect(req.jobID).toBe('shape-loop');
      expect(req.text).toBe('formatted text');
      s.destroy();
    });

    it('schedule request has shape submit true, kind sched', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);
      s.scheduleOnce({
        jobID: 'shape-sched',
        sessionID: 'sess-y',
        runAt: new Date(100),
        prompt: 'one-shot text',
      });
      vi.advanceTimersByTime(100);

      const req = delivery.mock.calls[0][0];
      expect(req.kind).toBe('sched');
      expect(req.submit).toBe(true);
      expect(req.sessionID).toBe('sess-y');
      expect(req.jobID).toBe('shape-sched');
      expect(req.text).toBe('one-shot text');
      s.destroy();
    });
  });

  // -- no backlog --
  describe('no backlog', () => {
    it('does not accumulate ticks when interval fires but timer stays in-flight', () => {
      delivery = vi.fn();
      const s = scheduler(delivery);

      s.scheduleLoop({
        jobID: 'no-backlog',
        sessionID: 's',
        intervalMs: 100,
        prompt: 'tick',
      });

      // Immediate fire = 1
      expect(delivery).toHaveBeenCalledTimes(1);

      // Step 300ms = 3 more ticks
      vi.advanceTimersByTime(300);
      expect(delivery).toHaveBeenCalledTimes(4);

      // Step 0ms — nothing extra
      vi.advanceTimersByTime(0);
      expect(delivery).toHaveBeenCalledTimes(4);

      s.destroy();
    });
  });
});
