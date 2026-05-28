import { MIN_LOOP_INTERVAL_MS } from '../limits.js';
import { parseDuration } from './time-utils.js';

export function parseLoop(raw: string): { intervalMs: number; prompt: string } {
  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx < 0) {
    throw new Error('loop: usage is <interval> <prompt> — e.g. "30s hello"');
  }

  const durationRaw = raw.slice(0, spaceIdx);
  const prompt = raw.slice(spaceIdx + 1).trim();
  if (prompt.length === 0) {
    throw new Error('loop: prompt is empty');
  }

  const intervalMs = parseDuration(durationRaw);
  if (intervalMs < MIN_LOOP_INTERVAL_MS) {
    throw new Error(`loop: interval must be at least ${MIN_LOOP_INTERVAL_MS}ms (minimum interval)`);
  }

  return { intervalMs, prompt };
}
