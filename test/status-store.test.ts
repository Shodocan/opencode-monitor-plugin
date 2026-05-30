import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyMonitorSnapshot, monitorStatusPath, normalizeMonitorScope, readMonitorStatus, writeMonitorStatus } from '../src/status-store.js';

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

  it('writes and reads active job snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opencode-monitor-status-'));
    vi.stubEnv('XDG_RUNTIME_DIR', dir);

    await writeMonitorStatus('/tmp/project', {
      version: 1,
      updatedAt: 123,
      jobs: [{ jobID: 'loop_1', kind: 'loop', sessionID: 's1', status: 'running', startedAt: 100, updatedAt: 123 }],
    });

    expect(readMonitorStatus('/tmp/project')).toEqual({
      version: 1,
      updatedAt: 123,
      jobs: [{ jobID: 'loop_1', kind: 'loop', sessionID: 's1', status: 'running', startedAt: 100, updatedAt: 123 }],
    });
  });

  it('returns empty snapshot for missing files', () => {
    expect(readMonitorStatus('/tmp/does-not-exist')).toEqual(expect.objectContaining({ version: 1, jobs: [] }));
    expect(emptyMonitorSnapshot()).toEqual(expect.objectContaining({ version: 1, jobs: [] }));
  });
});
