/**
 * Structured logging: one JSON object per line, on stdout (CLAUDE.md §5).
 *
 * Operator-facing scripts also print a human line, because a person watching a mainnet
 * transaction should not have to read JSON to see what is about to happen. Both go out;
 * the JSON is what a receipt or a CI log is built from.
 */
export type LogFields = Record<string, unknown>;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function logEvent(event: string, fields: LogFields = {}): void {
  write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** A line meant for the person running the script, not for a parser. */
export function say(message: string): void {
  write(message);
}

export function fail(message: string): never {
  logEvent("fatal", { message });
  process.exit(1);
}
