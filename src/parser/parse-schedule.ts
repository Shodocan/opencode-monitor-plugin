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
  const rest = raw.slice(3); // strip "in "
  const spaceIdx = findDurationSpace(rest);
  if (spaceIdx === -1) {
    throw new Error('schedule: missing prompt after duration');
  }

  const durationRaw = rest.slice(0, spaceIdx);
  const prompt = rest.slice(spaceIdx + 1).trim();

  // Validate duration unit (no 'd' allowed)
  const match = durationRaw.match(/^(\d+)(s|m|h)$/);
  if (!match) {
    throw new Error('schedule: duration must use s, m, or h (not d)');
  }

  const ms = parseDuration(durationRaw);
  const runAt = new Date(ref.getTime() + ms);

  const horizon = ref.getTime() + MAX_SCHEDULE_HORIZON_MS;
  if (runAt.getTime() > horizon) {
    throw new Error('schedule: target exceeds 30-day horizon');
  }

  return { runAt, prompt };
}

function parseScheduleAt(raw: string, ref: Date): { runAt: Date; prompt: string } {
  const rest = raw.slice(3); // strip "at "

  // Match ISO datetime: YYYY-MM-DDTHH:MM:SS.mmm or YYYY-MM-DDTHH:MM
  // Optionally followed by Z or ±HH:MM timezone offset
  const isoMatch = rest.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.*)/s);
  if (!isoMatch) {
    throw new Error('schedule: invalid ISO date after "at"');
  }

  const dateStr = isoMatch[1];
  const prompt = isoMatch[2] ?? '';

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

/**
 * Find the first space after a duration token (digits + single-letter unit).
 */
function findDurationSpace(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ' && /[a-z]/i.test(s[i - 1])) {
      return i;
    }
  }
  return -1;
}
