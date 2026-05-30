import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REDACT_KEY = /token|secret|password|authorization|credential/i;
const MAX_STRING = 500;

export function monitorDebugLogPath(): string {
  return process.env.OPENCODE_MONITOR_DEBUG_LOG
    || join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'opencode-monitor', 'debug.log');
}

function safeValue(value: unknown, key = ''): unknown {
  if (REDACT_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated:${value.length}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = safeValue(v, k);
    }
    return out;
  }
  return String(value);
}

export function monitorDebug(event: string, data: Record<string, unknown> = {}): void {
  if (process.env.OPENCODE_MONITOR_DEBUG === '0') return;
  const file = monitorDebugLogPath();
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...safeValue(data) as Record<string, unknown>,
  })}\n`;
  void mkdir(dirname(file), { recursive: true, mode: 0o700 })
    .then(() => appendFile(file, line, { mode: 0o600 }))
    .then(() => chmod(file, 0o600).catch(() => {}))
    .catch(() => {});
}
