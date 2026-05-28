import { MAX_REGEX_PATTERN_LENGTH, MIN_MONITOR_DEBOUNCE_S, MAX_MONITOR_DEBOUNCE_S, MAX_MONITOR_CONTEXT_LINES } from '../limits.js';

export function parseMonitor(raw: string): {
  regex: RegExp;
  before: number;
  after: number;
  debounceMs: number;
  command: string;
} {
  // Determine where the flags section ends and the command begins
  const flagEndIdx = findFlagEnd(raw);
  const command = raw.slice(flagEndIdx).trim();
  if (command.length === 0) {
    throw new Error('monitor: command is empty after --');
  }

  // Parse optional flags before --
  const flagsSection = raw.slice(0, flagEndIdx).trim();

  let regexStr: string | null = null;
  let flagStr = '';
  let before = 10;
  let after = 10;
  let debounceS: number | null = null;

  if (flagsSection.length > 0) {
    // Split on -- to get each flag+value pair
    const parts = flagsSection.split('--');
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (seg.startsWith('regex ')) {
        const r = seg.slice(6).trim();
        const parsed = parseRegexArg(r);
        regexStr = parsed.pattern;
        flagStr = parsed.flags;
      } else if (seg.startsWith('before ')) {
        const n = parseInt(seg.slice(7).trim(), 10);
        if (Number.isNaN(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES) {
          throw new Error(`--before must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
        }
        before = n;
      } else if (seg.startsWith('after ')) {
        const n = parseInt(seg.slice(6).trim(), 10);
        if (Number.isNaN(n) || n < 0 || n > MAX_MONITOR_CONTEXT_LINES) {
          throw new Error(`--after must be 0..${MAX_MONITOR_CONTEXT_LINES}, got ${n}`);
        }
        after = n;
      } else if (seg.startsWith('debounce ')) {
        debounceS = parseInt(seg.slice(9).trim(), 10);
      }
      // Also handle flags without space separator: --regex /pat/i, --before 0, etc.
    }
  }

  if (regexStr === null) {
    throw new Error('monitor: --regex is required');
  }

  if (debounceS === null) {
    if (debounceS !== 0) {
      throw new Error('monitor: --debounce is required (1..60 seconds)');
    }
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
    const closeSlash = findRegexEnd(raw);
    if (closeSlash === -1) {
      throw new Error(`monitor: unclosed regex delimiter in "${raw}"`);
    }
    pattern = raw.slice(1, closeSlash);
    flags = raw.slice(closeSlash + 1).trim();
  } else {
    pattern = raw;
  }

  // Validate regex length
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `monitor: regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters (${pattern.length})`
    );
  }

  // Validate flags - allow i, m, u; reject g, y
  if (flags.length > 0) {
    for (const ch of flags) {
      if ('iygu'.includes(ch)) {
        if (ch === 'g' || ch === 'y') {
          throw new Error(`monitor: unsupported regex flag '${ch}' (allowed: i,m,u)`);
        }
      } else if (!'imuy'.includes(ch)) {
        // Allow unknown flags to pass through — engine may not support them
      }
    }
  }

  return { pattern, flags };
}

function findRegexEnd(raw: string): number {
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '/' && raw[i - 1] !== '\\') {
      return i;
    }
  }
  return -1;
}

function findFlagEnd(raw: string): number {
  // Find the final occurrence of " -- " that introduces the command
  // The last " -- " before the command string
  let idx = raw.lastIndexOf(' --');
  if (idx === -1) {
    throw new Error('monitor: -- separator between flags and command is required');
  }
  // If the index is at the start or right after another --, verify it's the separator
  return idx + 3;
}
