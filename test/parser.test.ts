import { describe, expect, it } from 'vitest';
import { parseBackground } from '../src/parser/parse-background.js';
import { parseMonitor } from '../src/parser/parse-monitor.js';
import { parseLoop } from '../src/parser/parse-loop.js';
import { parseSchedule } from '../src/parser/parse-schedule.js';
import { parseDuration, parseDate } from '../src/parser/time-utils.js';

describe('parseBackground', () => {
  it('strips outer double quotes', () => {
    expect(parseBackground(' "npm test" ').command).toBe('npm test');
  });

  it('strips outer single quotes', () => {
    expect(parseBackground(" 'npm test' ").command).toBe('npm test');
  });

  it('works without quotes', () => {
    expect(parseBackground('  npm run build  ').command).toBe('npm run build');
  });

  it('rejects empty command', () => {
    expect(() => parseBackground('   ')).toThrow('empty');
    expect(() => parseBackground('""')).toThrow('empty');
    expect(() => parseBackground("''")).toThrow('empty');
  });
});

describe('parseMonitor', () => {
  it('parses /pattern/flags with options', () => {
    const result = parseMonitor(
      '--regex /ERROR/iu --before 0 --after 200 --debounce 5 -- tail -f app.log'
    );
    expect(result.regex.flags).toContain('i');
    expect(result.regex.flags).toContain('u');
    expect(result.before).toBe(0);
    expect(result.after).toBe(200);
    expect(result.debounceMs).toBe(5000);
    expect(result.command).toBe('tail -f app.log');
  });

  it('parses plain pattern without slashes', () => {
    const result = parseMonitor('--regex ERROR --debounce 1 -- echo hello');
    expect(result.regex.source).toBe('ERROR');
    expect(result.debounceMs).toBe(1000);
    expect(result.command).toBe('echo hello');
  });

  it('rejects unsupported flag g', () => {
    expect(() => parseMonitor('--regex /x/g -- echo x')).toThrow('unsupported regex flag');
  });

  it('rejects unsupported flag y', () => {
    expect(() => parseMonitor('--regex /x/y -- echo x')).toThrow('unsupported regex flag');
  });

  it('rejects --before exceeding limit', () => {
    expect(() => parseMonitor('--regex /x/i --before 201 -- echo x')).toThrow('--before');
  });

  it('rejects --after exceeding limit', () => {
    expect(() => parseMonitor('--regex /x/i --after 201 -- echo x')).toThrow('--after');
  });

  it('rejects --debounce below 1', () => {
    expect(() => parseMonitor('--regex /x/i --debounce 0 -- echo x')).toThrow();
  });

  it('rejects --debounce above 60', () => {
    expect(() => parseMonitor('--regex /x/i --debounce 61 -- echo x')).toThrow();
  });

  it('rejects pattern exceeding 512 chars', () => {
    const long = 'x'.repeat(513);
    expect(() => parseMonitor(`--regex ${long} -- echo x`)).toThrow('512');
  });

  it('enforces -- separator before command', () => {
    const r = parseMonitor('--regex /x/i --debounce 1 -- echo hello');
    expect(r.command).toBe('echo hello');
  });

  it('allows i/m/u flags', () => {
    const result = parseMonitor('--regex /test/imu --debounce 1 -- echo ok');
    expect(result.regex.flags).toBe('imu');
  });

  it('rejects empty command after separator', () => {
    expect(() => parseMonitor('--regex /x/i --')).toThrow('command is empty');
  });

  describe('escaped slash handling', () => {
    it('single backslash before slash escapes it (odd count)', () => {
      // JS string '/a\\/b/i' → actual string /a\/b/i
      // One backslash before slash → odd → escaped, not delimiter
      const r = parseMonitor('--regex /a\\/b/i -- echo ok');
      expect(r.regex.source).toBe('a\\/b');
      expect(r.regex.flags).toBe('i');
    });

    it('zero backslashes before slash is delimiter (even count)', () => {
      expect(parseMonitor('--regex /x/i -- echo ok').regex.source).toBe('x');
    });

    it('two backslashes before slash is delimiter (even count)', () => {
      // JS string '/a\\\\/i' → actual string /a\\/i
      // Two backslashes → even → slash is delimiter
      const r = parseMonitor('--regex /a\\\\/i -- echo ok');
      expect(r.regex.source).toBe('a\\\\');
      expect(r.regex.flags).toBe('i');
    });

    it('escaped slash remains inside delimited regex pattern', () => {
      const r = parseMonitor('--regex /a\\/b/i -- echo ok');
      expect(r.regex.source).toBe('a\\/b');
      expect(r.regex.flags).toBe('i');
    });
  });
});

describe('parseLoop', () => {
  it('parses 30s interval', () => {
    const result = parseLoop('30s echo hello');
    expect(result.intervalMs).toBe(30_000);
    expect(result.prompt).toBe('echo hello');
  });

  it('parses 5m interval', () => {
    const result = parseLoop('5m run tests');
    expect(result.intervalMs).toBe(5 * 60 * 1000);
    expect(result.prompt).toBe('run tests');
  });

  it('rejects below 10s minimum', () => {
    expect(() => parseLoop('5s hello')).toThrow('minimum');
  });

  it('rejects empty prompt', () => {
    expect(() => parseLoop('30s')).toThrow('prompt');
  });

  it('rejects day unit (d) via parseDuration', () => {
    expect(() => parseLoop('5d check')).toThrow('unsupported unit');
  });
});

describe('parseSchedule', () => {
  it('parses "in 10m" schedule', () => {
    const now = new Date();
    const result = parseSchedule('in 10m run tests', now);
    expect(result.prompt).toBe('run tests');
    expect(result.runAt.getTime()).toBeCloseTo(now.getTime() + 10 * 60 * 1000, 0);
  });

  it('parses "in 1h" schedule', () => {
    const result = parseSchedule('in 1h deploy');
    expect(result.prompt).toBe('deploy');
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('parses "in 60s" schedule', () => {
    const result = parseSchedule('in 60s check');
    expect(result.prompt).toBe('check');
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('rejects past schedule', () => {
    const farRef = new Date(Date.now() + 60 * 60 * 1000);
    const result = parseSchedule('in 60s run', farRef);
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('rejects "at" target in the past', () => {
    const isoPast = '2020-01-01T00:00:00';
    expect(() => parseSchedule(`at ${isoPast} run`)).toThrow('future');
  });

  it('rejects duration with "d" unit', () => {
    expect(() => parseSchedule('in 5d check')).toThrow('not d');
  });

  it('rejects "in" with zero duration', () => {
    expect(() => parseSchedule('in 0s check')).toThrow('positive');
  });

  it('rejects "in" with zero minutes duration', () => {
    expect(() => parseSchedule('in 0m check')).toThrow('positive');
  });

  it('accepts "at" with future ISO date', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = parseSchedule(`at ${future} deploy`);
    expect(result.prompt).toBe('deploy');
    expect(result.runAt.getTime() > Date.now()).toBe(true);
  });

  it('rejects schedule beyond 30-day horizon', () => {
    const far = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => parseSchedule(`at ${far} deploy`)).toThrow('30-day');
  });
});

describe('parseDuration (time-utils)', () => {
  it('rejects unsupported unit "d"', () => {
    expect(() => parseDuration('5d')).toThrow('unsupported unit');
  });

  it('rejects unsupported unit "w"', () => {
    expect(() => parseDuration('2w')).toThrow('unsupported unit');
  });

  it('rejects malformed durations without unit', () => {
    expect(() => parseDuration('123')).toThrow('invalid format');
  });

  it('rejects malformed durations with multiple units', () => {
    expect(() => parseDuration('10s3m')).toThrow('invalid format');
  });

  it('handles leading zeros (e.g. 05s = 5000ms)', () => {
    expect(parseDuration('05s')).toBe(5_000);
  });

  it('handles zero duration (0s = 0ms)', () => {
    expect(parseDuration('0s')).toBe(0);
  });

  it('parses large values', () => {
    expect(parseDuration('10h')).toBe(10 * 60 * 60 * 1000);
  });
});

describe('parseDate (time-utils)', () => {
  it('parses valid ISO date', () => {
    const d = parseDate('2025-06-15T10:00:00Z');
      expect(d.getTime()).toBe(1749981600000);
  });

  it('accepts ISO without timezone (local)', () => {
    const d = parseDate('2025-06-15T10:00:00');
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('rejects malformed ISO (not a datetime)', () => {
    expect(() => parseDate('not-a-date')).toThrow('cannot parse');
  });

  it('rejects plain date-only string', () => {
    // "2025-06-15" is valid by Date constructor, should parse
    const d = parseDate('2025-06-15');
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});
