export function parseBackground(raw: string): { command: string } {
  const command = stripQuotes(raw.trim());
  if (command.length === 0) {
    throw new Error('background command is empty');
  }
  return { command };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
