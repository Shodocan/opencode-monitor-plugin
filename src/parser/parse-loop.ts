import { MIN_LOOP_INTERVAL_MS } from '../limits.js';
import { parseDuration } from './time-utils.js';

/**
 * Parse "/loop <interval> <command>" format.
 * Interval must be >= 10s. Minimum interval enforced.
 */
export function parseLoop(raw: string): { intervalMs: number; prompt: string } {
  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx === -1) {
    throw new Error('loop: missing interval');
  }

  const durationRaw = raw.slice(0, spaceIdx);
  const prompt = raw.slice(spaceIdx + 1).trim();
  if (prompt.length === 0) {
    throw new Error('loop: prompt is empty');
  }

  const intervalMs = parseDuration(durationRaw);
  if (intervalMs < MIN_LOOP_INTERVAL_MS) {
    throw new Error(
      `loop: interval ${durationRaw} is below minimum (${MIN_LOOP_INTERVAL_MS}ms/${MIN_LOOP_INTERVAL_MS / 1000}s)`
    );
  }

  return { intervalMs, prompt };
}
