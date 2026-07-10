import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyMonitorSnapshot,
  monitorStatusPath,
  monitorTailPath,
  normalizeMonitorScope,
  readMonitorStatus,
  writeMonitorStatus,
  writeMonitorTail,
  readMonitorTail,
  removeMonitorTail,
} from '../src/status-store.js';

describe('monitor status store', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a stable scoped runtime path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-status-'));
    vi.stubEnv('XDG_RUNTIME_DIR', dir);

    const one = monitorStatusPath('/tmp/project-a');
    const two = monitorStatusPath('/tmp/project-a');
    const other = monitorStatusPath('/tmp/project-b');

    expect(one).toBe(two);
    expect(one).not.toBe(other);
    expect(one).toContain(join(dir, 'opencode-monitor', 'status'));
  });

  it('normalizes equivalent scope paths before hashing', () => {
    expect(normalizeMonitorScope('/tmp/project/../project')).toBe('/tmp/project');
    expect(monitorStatusPath('/tmp/project/../project')).toBe(monitorStatusPath('/tmp/project'));
  });

  it('writes and reads v2 snapshots with new fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-status-'));
    vi.stubEnv('XDG_RUNTIME_DIR', dir);

    await writeMonitorStatus('/tmp/project', {
      version: 2,
      updatedAt: 123,
      jobs: [{ jobID: 'loop_1', kind: 'loop', sessionID: 's1', status: 'running', startedAt: 100, updatedAt: 123, createdAt: 90, deliveryStatus: 'pending', hasTail: false }],
      queueDepth: 3,
      dedupedCount: 2,
      coalescedTicks: 5,
      bridgeUp: false,
      queueDropped: 1,
      completedCount: 4,
      failedCount: 1,
      scheduledPending: 2,
    });

    const result = readMonitorStatus('/tmp/project');
    expect(result.version).toBe(2);
    expect(result.queueDepth).toBe(3);
    expect(result.dedupedCount).toBe(2);
    expect(result.coalescedTicks).toBe(5);
    expect(result.bridgeUp).toBe(false);
    expect(result.queueDropped).toBe(1);
    expect(result.completedCount).toBe(4);
    expect(result.failedCount).toBe(1);
    expect(result.scheduledPending).toBe(2);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].createdAt).toBe(90);
    expect(result.jobs[0].deliveryStatus).toBe('pending');
    expect(result.jobs[0].hasTail).toBe(false);
  });

  it('reads v1 snapshots with backward-compatible defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-status-'));
    vi.stubEnv('XDG_RUNTIME_DIR', dir);

    await writeMonitorStatus('/tmp/project', {
      version: 1,
      updatedAt: 123,
      jobs: [{ jobID: 'loop_1', kind: 'loop', sessionID: 's1', status: 'running', startedAt: 100, updatedAt: 123, createdAt: 0, deliveryStatus: 'unknown', hasTail: false }],
    } as any);

    const result = readMonitorStatus('/tmp/project');
    expect(result.version).toBe(2);
    expect(result.queueDepth).toBe(0);
    expect(result.bridgeUp).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].deliveryStatus).toBe('unknown');
    expect(result.jobs[0].hasTail).toBe(false);
  });

  it('returns empty v2 snapshot for missing files', () => {
    const result = readMonitorStatus('/tmp/does-not-exist');
    expect(result.version).toBe(2);
    expect(result.jobs).toEqual([]);
    expect(result.queueDepth).toBe(0);
    expect(result.bridgeUp).toBe(true);
    expect(emptyMonitorSnapshot().version).toBe(2);
  });
});

describe('monitor tail files', () => {
  let dir: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads tail files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-tail-'));
    vi.stubEnv('XDG_RUNTIME_DIR', dir);

    const lines = [
      { stream: 'stdout', line: 'Building...' },
      { stream: 'stderr', line: 'warning: unused import' },
    ];
    await writeMonitorTail('/tmp/project', 'bg_1', lines, false);

    const tail = readMonitorTail('/tmp/project', 'bg_1');
    expect(tail).not.toBeNull();
    expect(tail!.jobID).toBe('bg_1');
    expect(tail!.lines).toHaveLength(2);
    expect(tail!.lines[0].stream).toBe('stdout');
    expect(tail!.lines[0].line).toBe('Building...');
    expect(tail!.lines[1].stream).toBe('stderr');
    expect(tail!.truncated).toBe(false);
  });

  it('returns null for missing tail files', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', tmpdir());
    expect(readMonitorTail('/tmp/project', 'nonexistent')).toBeNull();
  });

  it('removes tail files without error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-tail-'));
    vi.stubEnv('XDG_RUNTIME_DIR', dir);

    await writeMonitorTail('/tmp/project', 'mon_1', [{ stream: 'stdout', line: 'hello' }], false);
    await removeMonitorTail('/tmp/project', 'mon_1');
    expect(readMonitorTail('/tmp/project', 'mon_1')).toBeNull();
    // Second removal should not throw
    await removeMonitorTail('/tmp/project', 'mon_1');
  });
});