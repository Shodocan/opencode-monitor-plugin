import {
  MAX_MONITOR_CONTEXT_LINES,
  MAX_REGEX_PATTERN_LENGTH,
  MIN_MONITOR_DEBOUNCE_S,
  MAX_MONITOR_DEBOUNCE_S,
} from '../limits.js';

function findSeparator(raw: string): number {
  // Walk every "--" token; the last standalone "--" is the command separator.
  let idx = 0;
  let lastSep: number | null = null;

  while (idx < raw.length) {
    const p = raw.indexOf('-', idx);
    if (p < 0) break;

    if (p + 1 < raw.length && raw[p + 1] === '-') {
      const okBefore = p === 0 || raw[p - 1] === ' ';
      const okAfter = p + 2 >= raw.length || raw[p + 2] === ' ';
      if (okBefore && okAfter) lastSep = p;
      idx = p + 3;
    } else {
      idx = p + 1;
    }
  }
  return lastSep ?? -1;
}

function countConsecutiveBackslashes(s: string, from: number): number {
  let count = 0;
  let i = from;
  while (i >= 0 && s[i] === '\\') {
    count++;
    i--;
  }
  return count;
}

function parseRegex(raw: string): { pattern: string; flags: string } {
  if (raw.startsWith('/')) {
    let pos = 1;
    while (pos < raw.length) {
      if (raw[pos] === '/') {
        const bsCount = countConsecutiveBackslashes(raw, pos - 1);
        if (bsCount % 2 === 0) break;
      }
      pos++;
    }
    if (pos >= raw.length) throw new Error('parseMonitor: unclosed regex pattern');
    const pattern = raw.slice(1, pos);
    const flags = raw.slice(pos + 1).trim();
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH)
      throw new Error(`parseMonitor: regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`);
    return { pattern, flags };
  }
  if (raw.length > MAX_REGEX_PATTERN_LENGTH)
    throw new Error(`parseMonitor: pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`);
  return { pattern: raw, flags: '' };
}

function checkFlags(flags: string): void {
  for (const ch of flags) {
    if (ch === 'g') throw new Error("parseMonitor: unsupported regex flag 'g'");
    if (ch === 'y') throw new Error("parseMonitor: unsupported regex flag 'y'");
  }
}

export function parseMonitor(raw: string): {
  regex: RegExp;
  before: number;
  after: number;
  debounceMs: number;
  command: string;
} {
  const sep = findSeparator(raw);
  if (sep < 0) throw new Error('parseMonitor: missing -- separator before command');

  const command = raw.slice(sep + 2).trim();
  if (command.length === 0) throw new Error('parseMonitor: command is empty');

  const flagsPart = raw.slice(0, sep).trim();
  let regex: RegExp | null = null;
  let before: number | null = null;
  let after: number | null = null;
  let debounce: number | null = null;
  let hasRegex = false;

  const segments = flagsPart.split('--');
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].trim();
    if (seg.length === 0) continue;
    if (seg.startsWith('regex ')) {
      hasRegex = true;
      const rstr = seg.slice(6).trim();
      const { pattern, flags } = parseRegex(rstr);
      checkFlags(flags);
      regex = new RegExp(pattern, flags);
    } else if (seg.startsWith('before ')) {
      const n = Number(seg.slice(7).trim());
      if (!Number.isInteger(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES)
        throw new Error(`parseMonitor: --before must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
      before = n;
    } else if (seg.startsWith('after ')) {
      const n = Number(seg.slice(6).trim());
      if (!Number.isInteger(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES)
        throw new Error(`parseMonitor: --after must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
      after = n;
    } else if (seg.startsWith('debounce ')) {
      const n = Number(seg.slice(9).trim());
      if (!Number.isInteger(n) || n < MIN_MONITOR_DEBOUNCE_S || n > MAX_MONITOR_DEBOUNCE_S)
        throw new Error(
          `parseMonitor: --debounce must be ${MIN_MONITOR_DEBOUNCE_S}..${MAX_MONITOR_DEBOUNCE_S}, got ${n}`
        );
      debounce = n;
    }
  }

  if (!hasRegex) throw new Error('parseMonitor: --regex is required');
  if (debounce === null) debounce = 5;
  return {
    regex: regex!,
    before: before ?? 10,
    after: after ?? 10,
    debounceMs: debounce * 1_000,
    command,
  };
}
