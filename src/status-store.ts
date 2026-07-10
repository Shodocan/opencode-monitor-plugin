import crypto from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
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
  createdAt: number;
  deliveryStatus: string;
  hasTail: boolean;
}

export interface MonitorIndicatorSnapshot {
  version: 2;
  updatedAt: number;
  jobs: MonitorIndicatorJob[];
  queueDepth: number;
  dedupedCount: number;
  coalescedTicks: number;
  bridgeUp: boolean;
  queueDropped: number;
  completedCount: number;
  failedCount: number;
  scheduledPending: number;
}

export interface MonitorTailLine {
  stream: string;
  line: string;
}

export interface MonitorTail {
  jobID: string;
  updatedAt: number;
  lines: MonitorTailLine[];
  truncated: boolean;
}

export function emptyMonitorSnapshot(): MonitorIndicatorSnapshot {
  return {
    version: 2,
    updatedAt: Date.now(),
    jobs: [],
    queueDepth: 0,
    dedupedCount: 0,
    coalescedTicks: 0,
    bridgeUp: true,
    queueDropped: 0,
    completedCount: 0,
    failedCount: 0,
    scheduledPending: 0,
  };
}

export function normalizeMonitorScope(scope = process.cwd()): string {
  return resolve(scope || process.cwd());
}

function scopeHash(scope: string): string {
  return crypto.createHash('sha256').update(normalizeMonitorScope(scope)).digest('hex').slice(0, 16);
}

export function monitorStatusPath(scope = process.cwd()): string {
  const root = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(root, 'opencode-monitor', 'status', `${scopeHash(scope)}.json`);
}

export function monitorTailPath(scope: string, jobID: string): string {
  const root = process.env.XDG_RUNTIME_DIR || tmpdir();
  return join(root, 'opencode-monitor', 'tail', scopeHash(scope), `${jobID}.log`);
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
    const parsed = JSON.parse(readFileSync(monitorStatusPath(scope), 'utf8')) as Partial<MonitorIndicatorSnapshot> & { jobs?: MonitorIndicatorJob[] };
    if (!Array.isArray(parsed.jobs)) return emptyMonitorSnapshot();
    const jobs: MonitorIndicatorJob[] = parsed.jobs.map((job) => ({
      jobID: job.jobID,
      kind: job.kind,
      sessionID: job.sessionID,
      status: job.status,
      startedAt: Number(job.startedAt) || 0,
      updatedAt: Number(job.updatedAt) || 0,
      createdAt: Number(job.createdAt) || 0,
      deliveryStatus: typeof job.deliveryStatus === 'string' ? job.deliveryStatus : 'unknown',
      hasTail: Boolean(job.hasTail),
    }));
    if (parsed.version === 2) {
      return {
        version: 2,
        updatedAt: Number(parsed.updatedAt) || 0,
        jobs,
        queueDepth: Number(parsed.queueDepth) || 0,
        dedupedCount: Number(parsed.dedupedCount) || 0,
        coalescedTicks: Number(parsed.coalescedTicks) || 0,
        bridgeUp: parsed.bridgeUp !== false,
        queueDropped: Number(parsed.queueDropped) || 0,
        completedCount: Number(parsed.completedCount) || 0,
        failedCount: Number(parsed.failedCount) || 0,
        scheduledPending: Number(parsed.scheduledPending) || 0,
      };
    }
    // v1 backward-compat: fill new fields with defaults
    return {
      version: 2,
      updatedAt: Number(parsed.updatedAt) || 0,
      jobs,
      queueDepth: 0,
      dedupedCount: 0,
      coalescedTicks: 0,
      bridgeUp: true,
      queueDropped: 0,
      completedCount: 0,
      failedCount: 0,
      scheduledPending: 0,
    };
  } catch {
    return emptyMonitorSnapshot();
  }
}

export async function writeMonitorTail(scope: string, jobID: string, lines: MonitorTailLine[], truncated: boolean): Promise<void> {
  const file = monitorTailPath(scope, jobID);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const payload: MonitorTail = { jobID, updatedAt: Date.now(), lines, truncated };
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

export function readMonitorTail(scope: string, jobID: string): MonitorTail | null {
  try {
    const parsed = JSON.parse(readFileSync(monitorTailPath(scope, jobID), 'utf8')) as Partial<MonitorTail>;
    if (!Array.isArray(parsed.lines)) return null;
    return {
      jobID,
      updatedAt: Number(parsed.updatedAt) || 0,
      lines: parsed.lines as MonitorTailLine[],
      truncated: Boolean(parsed.truncated),
    };
  } catch {
    return null;
  }
}

export async function removeMonitorTail(scope: string, jobID: string): Promise<void> {
  try {
    await unlink(monitorTailPath(scope, jobID));
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT') return;
    monitorDebug('tail.remove.error', { jobID, error: error instanceof Error ? error.message : String(error) });
  }
}