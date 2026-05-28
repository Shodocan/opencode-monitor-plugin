import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OutputEvent } from '../src/types.js';
import { MonitorEngine } from '../src/runner/monitor-engine.js';
import type { MonitorWindow, MonitorEngineOptions } from '../src/runner/monitor-engine.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEvent(seq: number, line: string, stream: 'stdout' | 'stderr' = 'stdout'): OutputEvent {
  return { jobID: 'job-a', seq, stream, line, timestamp: 1_000 + seq * 10 };
}

function makeEventForJob(jobID: string, seq: number, line: string): OutputEvent {
  return { jobID, seq, stream: 'stdout', line, timestamp: 1_000 + seq * 10 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MonitorEngine', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  // -- ring cap / truncation --

  it('should mark truncated when ring buffer drops before-lines', () => {
    const ringSize = 3;
    const before = 10;
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before, after: 0, debounceMs: 0, ringSize, onWindow,
    });

    // fill ring beyond capacity + match
    engine.ingest(makeEvent(1, 'ok1'));
    engine.ingest(makeEvent(2, 'ok2'));
    engine.ingest(makeEvent(3, 'ok3'));
    // ring now has [seq1, seq2, seq3]; next ingest pushes out seq1
    engine.ingest(makeEvent(4, 'ERR')); // match - needs before=10 but only 3 events in ring

    // debounceMs=0 so delivery is immediate once after-lines are satisfied (0 needed)
    expect(onWindow).toHaveBeenCalledTimes(1);
    const w = onWindow.mock.calls[0][0];
    expect(w.truncated).toBe(true);
  });

  it('should NOT mark truncated when enough before-lines are available', () => {
    const ringSize = 10;
    const before = 2;
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before, after: 0, debounceMs: 0, ringSize, onWindow,
    });

    engine.ingest(makeEvent(1, 'ok1'));
    engine.ingest(makeEvent(2, 'ok2'));
    engine.ingest(makeEvent(3, 'ERR')); // match with before=2

    expect(onWindow).toHaveBeenCalledTimes(1);
    expect(onWindow.mock.calls[0][0].truncated).toBe(false);
  });

  // -- before/after window bounds --

  it('should collect before-lines up to the requested count', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 2, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'line1'));
    engine.ingest(makeEvent(2, 'line2'));
    engine.ingest(makeEvent(3, 'ERR'));

    expect(onWindow).toHaveBeenCalledTimes(1);
    const events = onWindow.mock.calls[0][0].events;
    // before-lines + match line
    expect(events.length).toBe(3); // seq1, seq2, seq3
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
    expect(events[2].seq).toBe(3);
  });

  it('should include only the matching line when before=0 and after=0', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'line1'));
    engine.ingest(makeEvent(2, 'line2'));
    engine.ingest(makeEvent(3, 'ERR'));

    expect(onWindow).toHaveBeenCalledTimes(1);
    expect(onWindow.mock.calls[0][0].events.map((event: OutputEvent) => event.seq)).toEqual([3]);
  });

  it('should include after-lines after match', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 2, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    // with debounceMs=0 and after=2, it should wait for 2 after-lines
    // flush immediately once after-lines are met
    engine.ingest(makeEvent(2, 'after1'));
    engine.ingest(makeEvent(3, 'after2'));

    expect(onWindow).toHaveBeenCalledTimes(1);
    const events = onWindow.mock.calls[0][0].events;
    expect(events.length).toBe(3);
    expect(events[0].seq).toBe(1);
    expect(events[2].seq).toBe(3);
  });

  it('should include match line in matchSeqs', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    expect(onWindow.mock.calls[0][0].matchSeqs).toEqual([1]);
  });

  // -- after-wait then debounce ordering --

  it('should wait for after-wait before debounce when after-lines not yet satisfied', () => {
    vi.useFakeTimers();
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 5, debounceMs: 100,
      afterWaitMs: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    // only 1 more after-line arrives; need 5 total
    engine.ingest(makeEvent(2, 'after1'));

    // At this point after-lines not met and afterWaitMs hasn't elapsed
    expect(onWindow).not.toHaveBeenCalled();

    // advance by afterWaitMs (50ms)
    vi.advanceTimersByTime(50);
    // now after-wait is done; window becomes ready
    // debounce timer starts
    expect(onWindow).not.toHaveBeenCalled(); // debounce waiting

    // advance past debounce
    vi.advanceTimersByTime(100);
    expect(onWindow).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // -- dedupe by seq --

  it('should ignore duplicate input seqs', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    engine.ingest(makeEvent(1, 'ERR-dup')); // same seq

    expect(onWindow).toHaveBeenCalledTimes(1);
    engine.ingest(makeEvent(2, 'ok'));
    expect(onWindow).toHaveBeenCalledTimes(1); // no extra call for seq 2 (non-match)
  });

  it('should not deliver a line seq that was already delivered', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR|OK/, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR')); // seq 1 matches and delivered
    engine.ingest(makeEvent(2, 'OK'));  // seq 2 matches and delivered

    // Both seqs should have been delivered; check no overlap
    const call1 = onWindow.mock.calls[0][0];
    const call2 = onWindow.mock.calls[1][0];
    const seqsAll = new Set([...call1.events.map((e: OutputEvent) => e.seq), ...call2.events.map((e: OutputEvent) => e.seq)]);
    expect(seqsAll.size).toBe(2);
  });

  // -- flush --

  it('flush() should immediately emit ready and pending windows with satisfied after-lines', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    // one match already delivered (debounceMs=0)
    engine.ingest(makeEvent(1, 'ERR'));
    expect(onWindow).toHaveBeenCalledTimes(1);

    // reset
    onWindow.mockClear();

    // ingest events that need after-lines
    const engine2 = new MonitorEngine({
      jobID: 'job-b', regex: /WARN/, before: 0, after: 3, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine2.ingest(makeEventForJob('job-b', 1, 'WARN'));
    engine2.ingest(makeEventForJob('job-b', 2, 'after1'));
    // only 1 of 3 after-lines so far; pending window exists

    // flush should emit with whatever after-lines we have
    engine2.flush();
    expect(onWindow).toHaveBeenCalledTimes(1);
  });

  // -- timeout callback --

  it('should call onAfterWaitTimeout when after-wait elapses without enough after-lines', () => {
    vi.useFakeTimers();
    const onWindow = vi.fn();
    const onTimeout = vi.fn();

    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 5, debounceMs: 0,
      afterWaitMs: 100, onWindow, onAfterWaitTimeout: onTimeout,
    });

    engine.ingest(makeEvent(1, 'ERR'));

    // advance past after-wait
    vi.advanceTimersByTime(100);

    expect(onTimeout).toHaveBeenCalledWith('job-a', 1);
    vi.useRealTimers();
  });

  it('should not call onAfterWaitTimeout when after-lines satisfy the window first', () => {
    vi.useFakeTimers();
    const onWindow = vi.fn();
    const onTimeout = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 2, debounceMs: 0,
      afterWaitMs: 100, onWindow, onAfterWaitTimeout: onTimeout,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    engine.ingest(makeEvent(2, 'after1'));
    engine.ingest(makeEvent(3, 'after2'));
    vi.advanceTimersByTime(100);

    expect(onWindow).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('should reject invalid constructor options', () => {
    const base: MonitorEngineOptions = {
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, onWindow: vi.fn(),
    };

    expect(() => new MonitorEngine({ ...base, before: -1 })).toThrow('before');
    expect(() => new MonitorEngine({ ...base, after: -1 })).toThrow('after');
    expect(() => new MonitorEngine({ ...base, debounceMs: -1 })).toThrow('debounceMs');
    expect(() => new MonitorEngine({ ...base, afterWaitMs: -1 })).toThrow('afterWaitMs');
    expect(() => new MonitorEngine({ ...base, ringSize: 0 })).toThrow('ringSize');
  });

  // -- ignore other jobs --

  it('should ignore events from other jobIDs', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEventForJob('job-other', 1, 'ERR'));
    expect(onWindow).not.toHaveBeenCalled();
  });

  // -- destroy --

  it('destroy() should cancel timers so no pending delivery occurs', () => {
    vi.useFakeTimers();
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 5, debounceMs: 100,
      afterWaitMs: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    engine.destroy();

    // even after advancing past all timers, no delivery
    vi.advanceTimersByTime(500);
    expect(onWindow).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // -- stateful regex (lastIndex reset) --

  it('should reset lastIndex before each regex test', () => {
    const regex = /ERR/;
    regex.lastIndex = 100; // simulate stale state
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex, before: 0, after: 0, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'ERR'));
    expect(onWindow).toHaveBeenCalledTimes(1);
  });

  // -- merge ready windows during debounce --

  it('should merge ready windows delivered during debounce period', () => {
    vi.useFakeTimers();
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 0, after: 0, debounceMs: 200, ringSize: 50, onWindow,
    });

    // two matches in quick succession
    engine.ingest(makeEvent(1, 'ERR'));
    engine.ingest(makeEvent(2, 'ERR'));

    // Both windows become ready (after=0, no after-wait wait needed beyond debounce)
    // With debounceMs=200, both should merge into one delivery
    vi.advanceTimersByTime(200);

    expect(onWindow).toHaveBeenCalledTimes(1);
    const merged = onWindow.mock.calls[0][0];
    const hasBoth = merged.events.some((e: OutputEvent) => e.seq === 1) &&
                    merged.events.some((e: OutputEvent) => e.seq === 2);
    expect(hasBoth).toBe(true);
    expect(merged.matchSeqs).toContain(1);
    expect(merged.matchSeqs).toContain(2);
    vi.useRealTimers();
  });

  it('should merge overlapping windows without redelivering shared seqs', () => {
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 1, after: 1, debounceMs: 0, ringSize: 50, onWindow,
    });

    engine.ingest(makeEvent(1, 'before'));
    engine.ingest(makeEvent(2, 'ERR-one'));
    engine.ingest(makeEvent(3, 'ERR-two'));
    engine.ingest(makeEvent(4, 'after'));

    expect(onWindow).toHaveBeenCalledTimes(2);
    const deliveredSeqs = onWindow.mock.calls.flatMap(([window]: [MonitorWindow]) =>
      window.events.map((event) => event.seq),
    );
    expect(deliveredSeqs).toEqual([1, 2, 3, 4]);
  });

  // -- stdout+stderr ring merge --

  it('should ring-buffer both stdout and stderr combined', () => {
    const ringSize = 3;
    const onWindow = vi.fn();
    const engine = new MonitorEngine({
      jobID: 'job-a', regex: /ERR/, before: 5, after: 0,
      debounceMs: 0, ringSize, onWindow,
    });

    engine.ingest({ ...makeEvent(1, 'out1'), stream: 'stdout' });
    engine.ingest({ ...makeEvent(2, 'err1'), stream: 'stderr' });
    engine.ingest({ ...makeEvent(3, 'out2'), stream: 'stdout' });
    // ring is full at 3; next event pushes out seq 1
    engine.ingest({ ...makeEvent(4, 'ERR'), stream: 'stdout' });

    expect(onWindow).toHaveBeenCalledTimes(1);
    // ring only has seq 2,3; match is seq 4; before=5 needed but only 2 available
    // truncated=true because we dropped events
    expect(onWindow.mock.calls[0][0].truncated).toBe(true);
  });
});
