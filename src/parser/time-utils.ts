export function parseDuration(raw: string): number {
  const match = raw.trim().match(/^(\d+)([a-z])$/);
  if (!match) throw new Error(`parseDuration: invalid format "${raw}", expected <int><s|m|h>`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return value * 1_000;
  if (unit === 'm') return value * 60 * 1_000;
  if (unit === 'h') return value * 60 * 60 * 1_000;
  throw new Error(`parseDuration: unsupported unit "${unit}" (allowed: s, m, h)`);
}

export function parseDate(raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`parseDate: cannot parse "${raw}"`);
  return d;
}
