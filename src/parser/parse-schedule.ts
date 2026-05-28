import { MAX_SCHEDULE_HORIZON_MS } from '../limits.js';
import { parseDuration, parseDate } from './time-utils.js';

export function parseSchedule(raw: string, now?: Date): { runAt: Date; prompt: string } {
  const ref = now ?? new Date();

  if (raw.startsWith('in ')) {
    return parseIn(raw, ref);
  }
  if (raw.startsWith('at ')) {
    return parseAt(raw, ref);
  }
  throw new Error('parseSchedule: first word must be "in" or "at"');
}

function parseIn(raw: string, ref: Date): { runAt: Date; prompt: string } {
  const rest = raw.slice(3);
  const m = rest.match(/^(\d+)([a-z])\s+(.*)/s);
  if (!m) throw new Error('parseSchedule: invalid duration in "in" argument');
  const unit = m[2];
  if (unit === 'd') throw new Error("parseSchedule: not d — use s, m, or h");
  const durationRaw = m[1] + unit;
  const ms = parseDuration(durationRaw);
  if (ms <= 0) throw new Error("parseSchedule: duration must be positive (reject '0s' and equivalent)");
  const runAt = new Date(ref.getTime() + ms);

  const horizonMs = ref.getTime() + MAX_SCHEDULE_HORIZON_MS;
  if (runAt.getTime() > horizonMs) throw new Error('parseSchedule: target exceeds 30-day horizon');

  return { runAt, prompt: m[3] };
}

function parseAt(raw: string, ref: Date): { runAt: Date; prompt: string } {
  const rest = raw.slice(3);
  const m = rest.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.*)/s
  );
  if (!m) throw new Error('parseSchedule: invalid ISO date in "at" argument');

  const runAt = parseDate(m[1]);
  const nowMs = ref.getTime();
  if (runAt.getTime() <= nowMs)
    throw new Error('parseSchedule: "at" target must be in the future (not past)');
  if (runAt.getTime() > nowMs + MAX_SCHEDULE_HORIZON_MS)
    throw new Error('parseSchedule: "at" target exceeds 30-day horizon');

  return { runAt, prompt: m[2] };
}
