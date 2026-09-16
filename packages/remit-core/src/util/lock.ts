/**
 * A lock two processes can agree on, built from one atomic filesystem operation.
 *
 * The rules this project enforces are read-modify-write rules. `dailyCapUsd` is "what the
 * ledger already holds, plus this action"; a receipt's `prevHash` is "whatever the last
 * record on disk says". Both are correct exactly once, and both are wrong the moment two
 * writers evaluate them against the same state — two proposals each see an empty day and
 * each spend the whole cap, or two appends claim sequence 7 and one of them disappears.
 *
 * The ops scripts, the Python bridge and the console are separate processes sharing a
 * directory, so the lock has to be one too. `open(O_CREAT | O_EXCL)` is atomic on every
 * filesystem this runs on and is the same primitive in both runtimes, which is why the
 * bridge's `remit_bridge.lock` can hold the *same* file and the two interlock.
 *
 * A stale lock — a process killed between acquire and release — is broken after
 * `staleMs`, because a system that deadlocks until somebody notices is a system that
 * fails open the moment somebody deletes the file to get moving again.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export class LockTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly waitedMs: number,
    readonly holder: string,
  ) {
    super(
      `could not take ${path} after ${waitedMs}ms — it is held by ${holder}. ` +
        "Nothing was written: a cap counted against a history somebody else is still " +
        "changing is not a cap.",
    );
    this.name = "LockTimeoutError";
  }
}

export type LockOptions = {
  /** How long to wait for the holder to finish before refusing. */
  readonly timeoutMs?: number;
  /**
   * Called once, the first time the lock is found held.
   *
   * Waiting is correct and can legitimately last as long as a person takes to answer a
   * review — but a command that prints nothing for twelve minutes looks exactly like a
   * command that has hung, and the operator's next move is to kill it. Saying who holds
   * it costs a line.
   */
  readonly onWait?: (holder: string) => void;
  /**
   * After this much silence, a lock is assumed to belong to a process that died holding
   * it.
   *
   * Silence, not age: a holder touches the file while it works (see `withLockAsync`), so
   * this is "how long since the holder last said it was alive" rather than "how long the
   * lock has existed". That is what lets it be short while a legitimate hold is long — a
   * G3 review takes ten minutes and a crashed process should not block the next action
   * for ten.
   */
  readonly staleMs?: number;
  /**
   * Called if the lock stops being ours while we hold it.
   *
   * Only reachable when something displaced us — a waiter that judged us dead. The hold
   * cannot be undone from here, and interrupting work that is already in flight would be
   * its own hazard, so this exists to make the fact *loud* rather than to recover from
   * it. Whatever this hold computed was computed against a history somebody else may
   * have been changing.
   */
  readonly onLost?: (holder: string) => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
/** Six heartbeats. Short enough that a killed holder is recovered from in a minute. */
const DEFAULT_STALE_MS = 90_000;
/** How often a long hold says it is still alive. */
const HEARTBEAT_MS = 15_000;

function holderOf(path: string): string {
  try {
    return readFileSync(path, "utf8").trim() || "an unnamed process";
  } catch {
    return "a process that has since released it";
  }
}

/** True when the holder has not touched the file for `staleMs` and may be displaced. */
function isStale(path: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > staleMs;
  } catch {
    // Gone between the failed create and this check: not stale, just released.
    return false;
  }
}

/**
 * What this holder writes into the lock, and the only thing that identifies it.
 *
 * A pid is not an identity: pids are reused, and two acquisitions by the same process are
 * two different holds. The random suffix makes the token unique per acquisition, which is
 * what lets a holder answer "is this still mine?" — and lets a release refuse to remove
 * somebody else's lock.
 *
 * The human prefix stays because `onWait` prints it to an operator who is trying to find
 * out who is holding things up.
 */
function newToken(): string {
  return `pid ${process.pid} since ${new Date().toISOString()} ${randomBytes(8).toString("hex")}`;
}

function tokenAt(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Is the lock on disk the one this holder created? */
function stillOurs(path: string, token: string): boolean {
  return tokenAt(path) === token.trim();
}

function tryAcquire(path: string, token: string): boolean {
  try {
    const handle = openSync(path, "wx");
    try {
      writeSync(handle, `${token}\n`);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  // Created — but a waiter breaking a stale lock could have removed it in the moment
  // between the create and here, and created its own. Read it back rather than assume:
  // the whole point of a token is that this question has an answer.
  return stillOurs(path, token);
}

/**
 * How long a *break claim* may be held before it is assumed abandoned.
 *
 * A claim is held for the microseconds it takes to re-read one file, so this is generous
 * by four orders of magnitude. It exists only so that a process killed between claiming
 * and breaking cannot stop every other waiter from ever breaking anything.
 */
const CLAIM_STALE_MS = 5_000;

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Break a lock left behind by a process that is not coming back.
 *
 * This is the one operation that can go wrong in a way the rest of the design cannot
 * recover from: removing a lock somebody is *actually holding* puts two processes inside
 * the same critical section, and the critical section here is a whole proposal — G1's
 * reading of the ledger, a chain transaction, and the ledger write that records it. Two
 * of those at once is the daily cap counted twice.
 *
 * `unlink` on its own was wrong twice over, and measurably so: with a stale lock present
 * and four waiters, two of them were inside together in seven runs out of forty.
 *
 * 1. **Two waiters could both break the same lock.** Both crossed the staleness check,
 *    both removed what they saw, both created their own. `rename` narrows that but does
 *    not close it, so the right to break a given lock is claimed first, with the same
 *    atomic create the lock itself uses. Exactly one waiter gets it.
 *
 * 2. **A waiter could break a lock that had stopped being stale.** Its `stat` was read
 *    before the previous holder released and a new one took over, and the unlink landed
 *    after. So the claim-holder re-reads the *identity* — token and mtime — and breaks
 *    only what it actually judged dead. A new holder writes a different token; a live one
 *    moves the mtime every heartbeat. Either change means this is not that lock.
 *
 * What remains is a lock whose token and mtime are both unchanged and whose silence is
 * longer than `staleMs`, which is the definition of the thing being broken.
 */
function breakStale(path: string, staleMs: number): void {
  const victim = tokenAt(path);
  const seenAt = mtimeOf(path);
  if (victim === undefined || seenAt === undefined) return;

  const claim = `${path}.break`;
  try {
    closeSync(openSync(claim, "wx"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Somebody else is breaking this one. Unless they died holding the claim, in which
    // case nothing could ever be broken again — so a claim ages out too, on a window
    // four orders of magnitude longer than a claim legitimately lasts.
    if (Date.now() - (mtimeOf(claim) ?? Date.now()) > CLAIM_STALE_MS) {
      rmSync(claim, { force: true });
    }
    return;
  }

  try {
    if (
      tokenAt(path) === victim &&
      mtimeOf(path) === seenAt &&
      Date.now() - seenAt > staleMs
    ) {
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(claim, { force: true });
  }
}

/** Release, but only what we are actually holding. */
function release(path: string, token: string): void {
  // Unconditional removal turned one stolen lock into a cascade: the displaced holder
  // deleted the *new* holder's file on its way out, letting a third process walk in
  // while the second was still inside its critical section.
  if (stillOurs(path, token)) rmSync(path, { force: true });
}

/**
 * Block this thread for `ms`, without spinning.
 *
 * `Atomics.wait` on a buffer nobody notifies is the only way to sleep synchronously in
 * Node, and it has to be synchronous: every caller of `withLock` is a synchronous
 * read-modify-write, and an `await` inside one would let the event loop run another
 * caller's critical section in the gap — which is the race the lock exists to close.
 */
const PARK = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(PARK, 0, 0, ms);
}

function acquire(
  path: string,
  token: string,
  timeoutMs: number,
  staleMs: number,
  wait: () => void,
  onWait?: (holder: string) => void,
): void {
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(path), { recursive: true });

  let announced = false;
  while (!tryAcquire(path, token)) {
    if (!announced) {
      announced = true;
      onWait?.(holderOf(path));
    }
    if (isStale(path, staleMs)) {
      // Taken from a process that is not coming back. Moved aside rather than deleted:
      // two waiters may reach this line together, and only one of them may go on to
      // hold the lock — which `rmSync` did not deliver and `rename` does.
      breakStale(path, staleMs);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(path, timeoutMs, holderOf(path));
    }
    wait();
  }
}

/**
 * Run `work` with the lock held. Released whatever `work` does, including throwing.
 *
 * Synchronous, so it cannot heartbeat: the callers are read-modify-writes measured in
 * milliseconds, which is what makes that fine. A synchronous body that could run for
 * longer than `staleMs` does not belong here — it belongs in `withLockAsync`.
 */
export function withLock<T>(path: string, work: () => T, options: LockOptions = {}): T {
  const token = newToken();
  acquire(
    path,
    token,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.staleMs ?? DEFAULT_STALE_MS,
    () => sleepSync(25),
    options.onWait,
  );

  try {
    return work();
  } finally {
    release(path, token);
  }
}

/**
 * The same lock, held across something that awaits.
 *
 * The gated pipeline is the caller that needs this: its critical section spans G1's
 * decision, a chain transaction and the ledger append that records it, and those have to
 * be one unit or two proposals both read a day in which nothing has been spent yet. The
 * wait between attempts yields to the event loop rather than parking the thread, because
 * the thing being waited *for* is another process's I/O.
 */
export async function withLockAsync<T>(
  path: string,
  work: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const token = newToken();

  mkdirSync(dirname(path), { recursive: true });

  let announced = false;
  while (!tryAcquire(path, token)) {
    if (!announced) {
      announced = true;
      options.onWait?.(holderOf(path));
    }
    if (isStale(path, staleMs)) {
      breakStale(path, staleMs);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(path, timeoutMs, holderOf(path));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // Say the holder is alive while it works. Without this, `staleMs` has to be longer
  // than the longest legitimate hold — a ten-minute G3 review — and a process killed
  // mid-hold then blocks every other action for ten minutes. With it, the window is a
  // property of the heartbeat rather than of the work.
  const heartbeat = setInterval(() => {
    // Touch only what is still ours. A displaced holder that kept touching the file was
    // keeping *somebody else's* lock alive, so the real holder's own heartbeat became
    // indistinguishable from ours and the file outlived them both.
    if (!stillOurs(path, token)) {
      options.onLost?.(holderOf(path));
      clearInterval(heartbeat);
      return;
    }
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // Gone between the check and the touch. `finally` still runs, and releasing a file
      // that is not there is not an error.
    }
  }, HEARTBEAT_MS);
  // Node would keep the process alive for a timer nobody is waiting on.
  heartbeat.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    release(path, token);
  }
}
