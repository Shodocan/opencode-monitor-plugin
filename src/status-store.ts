import crypto from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { JobKind } from './types.js';
import { monitorDebug } from './debug-log.js';

export interface MonitorIndicatorJob {
  jobID: string;
  kind: JobKind;
  sessionID: string;
  status: string;
  startedAt: number;
  updatedAt: number;
}

export interface MonitorIndicatorSnapshot {
  version: 1;
  updatedAt: number;
  jobs: MonitorIndicatorJob[];
}

export function emptyMonitorSnapshot(): MonitorIndicatorSnapshot {
  return { version: 1, updatedAt: Date.now(), jobs: [] };
}

export function normalizeMonitorScope(scope = process.cwd()): string {
  return resolve(scope || process.cwd());
}

export function monitorStatusPath(scope = process.cwd()): string {
  const root = process.env.XDG_RUNTIME_DIR || tmpdir();
  const hash = crypto.createHash('sha256').update(normalizeMonitorScope(scope)).digest('hex').slice(0, 16);
  return join(root, 'opencode-monitor', 'status', `${hash}.json`);
}

export async function writeMonitorStatus(scope: string, snapshot: MonitorIndicatorSnapshot): Promise<void> {
  const file = monitorStatusPath(scope);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  monitorDebug('status.write.ok', { scope: normalizeMonitorScope(scope), file, jobs: snapshot.jobs.map((job) => ({ jobID: job.jobID, kind: job.kind, sessionID: job.sessionID, status: job.status })) });
}

export function readMonitorStatus(scope: string): MonitorIndicatorSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(monitorStatusPath(scope), 'utf8')) as Partial<MonitorIndicatorSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) return emptyMonitorSnapshot();
    return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, jobs: parsed.jobs as MonitorIndicatorJob[] };
  } catch {
    return emptyMonitorSnapshot();
  }
}
