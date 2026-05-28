import { MAX_SCHEDULE_HORIZON_MS } from '../limits.js';
import { parseDuration, parseDateString } from './time-utils.js';

/**
 * Parse "/schedule in <duration> <prompt>" or "/schedule at <ISO> <prompt>".
 * Duration supports s/m/h but not d.
 * The "at" target must be future and within 30 days.
 */
export function parseSchedule(raw: string, now?: Date): { runAt: Date; prompt: string } {
  const ref = now ?? new Date();

  if (raw.startsWith('in ')) {
    return parseScheduleIn(raw, ref);
  } else if (raw.startsWith('at ')) {
    return parseScheduleAt(raw, ref);
  } else {
    throw new Error('schedule: must start with "in" or "at"');
  }
}

function parseScheduleIn(raw: string, ref: Date): { runAt: Date; prompt: string } {
  const rest = raw.slice(3);
  const match = rest.match(/^(\d+)([a-z])\s+(.*)/s);
  if (!match) {
    throw new Error('schedule: invalid duration — use <int><s|m|h>');
  }

  const unit = match[2];
  if (unit === 'd') {
    throw new Error("schedule: 'd' unit not supported (not d) — use s, m, or h");
  }

  const durationRaw = match[1] + unit;
  const prompt = match[3];

  const ms = parseDuration(durationRaw);
  const runAt = new Date(ref.getTime() + ms);

  const horizon = ref.getTime() + MAX_SCHEDULE_HORIZON_MS;
  if (runAt.getTime() > horizon) {
    throw new Error('schedule: target exceeds 30-day horizon');
  }

  return { runAt, prompt };
}

function parseScheduleAt(raw: string, ref: Date): { runAt: Date; prompt: string } {
  const rest = raw.slice(3);

  // Match ISO datetime including optional timezone suffix
  const match = rest.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.*)/s);
  if (!match) {
    throw new Error('schedule: invalid ISO format — use YYYY-MM-DDTHH:MM:SS');
  }

  const dateStr = match[1];
  const prompt = match[2];

  const runAt = parseDateString(dateStr);
  const nowMs = ref.getTime();

  if (runAt.getTime() <= nowMs) {
    throw new Error('schedule: "at" target must be in the future');
  }

  const horizon = nowMs + MAX_SCHEDULE_HORIZON_MS;
  if (runAt.getTime() > horizon) {
    throw new Error('schedule: "at" target exceeds 30-day horizon');
  }

  return { runAt, prompt };
}
