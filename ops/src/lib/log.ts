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

/**
 * Anything that gets out of a script still leaves one structured line.
 *
 * `fail()` is for a refusal a script already understands. This is for the other kind —
 * a library that threw, a promise nobody awaited — and it exists so that those do not
 * arrive as a raw stack trace on an operator's terminal at 02:00. The library code can
 * then throw, which is what makes it callable from something that is not a script and
 * testable by something that is not a subprocess.
 *
 * Registered on import, once. Every script reaches this module.
 */
function fatal(error: unknown): never {
  logEvent("fatal", {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined
      ? { stack: error.stack }
      : {}),
  });
  process.exit(1);
}

if (process.listenerCount("uncaughtException") === 0) {
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
}
