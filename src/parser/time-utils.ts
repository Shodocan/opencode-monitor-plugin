export function parseDuration(raw: string): number {
  const match = raw.trim().match(/^(\d+)(s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid duration: "${raw}". Use format: <int><s|m|h>`);
  }
  const n = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h';
  if (n < 0) {
    throw new Error('Duration must be non-negative');
  }
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return n * 60 * 60 * 1000;
}

export function parseDateString(raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${raw}"`);
  }
  return d;
}
