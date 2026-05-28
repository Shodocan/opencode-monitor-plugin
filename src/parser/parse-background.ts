/** Parse a background command: strip outer whitespace and optional quotes, reject empty. */
export function parseBackground(raw: string): { command: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('parseBackground: command is empty');

  // Strip matching outer quotes
  let command = trimmed;
  if (command.length >= 2 && command[0] === '"' && command.at(-1) === '"') {
    command = command.slice(1, -1);
  } else if (command.length >= 2 && command[0] === "'" && command.at(-1) === "'") {
    command = command.slice(1, -1);
  }

  if (command.length === 0) throw new Error('parseBackground: command is empty');
  return { command };
}
