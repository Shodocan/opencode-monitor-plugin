import { MAX_REGEX_PATTERN_LENGTH, MIN_MONITOR_DEBOUNCE_S, MAX_MONITOR_DEBOUNCE_S, MAX_MONITOR_CONTEXT_LINES } from '../limits.js';

export function parseMonitor(raw: string): {
  regex: RegExp;
  before: number;
  after: number;
  debounceMs: number;
  command: string;
} {
  // Find the last -- that separates flags from command
  const sepIndex = findCommandSeparator(raw);
  if (sepIndex < 0) {
    throw new Error('monitor: -- separator before command is required');
  }
  const command = raw.slice(sepIndex + 3).trim();
  if (command.length === 0) {
    throw new Error('monitor: command is empty after --');
  }

  const flagSection = raw.slice(0, sepIndex).trim();

  let regexStr: string | null = null;
  let flagStr = '';
  let before = -1;
  let after = -1;
  let debounceS: number | null = null;

  if (flagSection.length > 0) {
    const segments = flagSection.split('--');
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i].trim();
      const parts = seg.split(/\s+/);
      const key = parts[0];

      if (key === 'regex') {
        const rawRegex = seg.slice(5).trim();
        const parsed = parseRegexArg(rawRegex);
        regexStr = parsed.pattern;
        flagStr = parsed.flags;
      } else if (key === 'before') {
        const n = parseInt(parts[1], 10);
        if (Number.isNaN(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES) {
          throw new Error(`--before must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
        }
        before = n;
      } else if (key === 'after') {
        const n = parseInt(parts[1], 10);
        if (Number.isNaN(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES) {
          throw new Error(`--after must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
        }
        after = n;
      } else if (key === 'debounce') {
        const n = parseInt(parts[1], 10);
        if (Number.isNaN(n)) {
          throw new Error('--debounce must be a number');
        }
        debounceS = n;
      }
    }
  }

  const defaults = { before: 10, after: 10, debounceMs: 5_000 };
  if (before < 0) before = defaults.before;
  if (after < 0) after = defaults.after;

  if (regexStr === null) {
    throw new Error('monitor: --regex is required');
  }

  if (debounceS === null) {
    throw new Error('monitor: --debounce is required (1..60 seconds)');
  }
  if (debounceS < MIN_MONITOR_DEBOUNCE_S || debounceS > MAX_MONITOR_DEBOUNCE_S) {
    throw new Error(`monitor: --debounce must be ${MIN_MONITOR_DEBOUNCE_S}..${MAX_MONITOR_DEBOUNCE_S}, got ${debounceS}`);
  }

  const regex = new RegExp(regexStr, flagStr);
  return { regex, before, after, debounceMs: debounceS * 1000, command };
}

function parseRegexArg(raw: string): { pattern: string; flags: string } {
  let pattern: string;
  let flags = '';

  if (raw.startsWith('/')) {
    const closeSlash = findRegexEndSlash(raw);
    if (closeSlash < 0) {
      throw new Error(`monitor: unclosed regex in "${raw}"`);
    }
    pattern = raw.slice(1, closeSlash);
    flags = raw.slice(closeSlash + 1).trim();
  } else {
    pattern = raw;
  }

  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(`monitor: regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters (${pattern.length})`);
  }

  // Only i, m, u are supported
  for (const ch of flags) {
    if (ch !== 'i' && ch !== 'm' && ch !== 'u') {
      if (ch === 'g') {
        throw new Error("monitor: unsupported regex flag 'g' (allowed: i,m,u)");
      }
      if (ch === 'y') {
        throw new Error("monitor: unsupported regex flag 'y' (allowed: i,m,u)");
      }
      // Allow unknown flags (not 'g,y') to pass through
    }
  }

  return { pattern: raw.startsWith('/') ? pattern : raw, flags };
}

function findRegexEndSlash(raw: string): number {
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '/' && raw[i - 1] !== '\\') {
      return i;
    }
  }
  return -1;
}

/**
 * Find the last -- that separates flags from the command.
 * Uses a separate `found` variable to avoid overwriting `last` with -1.
 */
function findCommandSeparator(raw: string): number {
  let idx = 0;
  let last = -1;
  while (idx < raw.length) {
    const found = raw.indexOf('--', idx);
    if (found < 0) break;
    last = found;
    idx = found + 2;
  }
  return last;
}
