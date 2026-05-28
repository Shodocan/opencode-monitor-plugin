import { MIN_LOOP_INTERVAL_MS } from '../limits.js';
import { parseDuration } from './time-utils.js';

export function parseLoop(raw: string): { intervalMs: number; prompt: string } {
  const m = raw.match(/^(\S+)\s+(.+)$/s);
  if (!m) throw new Error('parseLoop: usage is "<interval> <prompt>"');
  const duration = m[1];
  const prompt = m[2]?.trim() ?? '';
  if (prompt.length === 0) throw new Error('parseLoop: prompt is empty');

  const ms = parseDuration(duration);
  if (ms < MIN_LOOP_INTERVAL_MS)
    throw new Error(
      `parseLoop: interval must be >= ${MIN_LOOP_INTERVAL_MS}ms (minimum interval)`
    );
  return { intervalMs: ms, prompt };
}
