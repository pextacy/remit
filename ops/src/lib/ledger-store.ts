/**
 * The rolling spend ledger, on disk.
 *
 * G1 is pure and takes the ledger as an argument (PRD.md G1-1); something has to hold it
 * between runs, and that is this file. Plain JSON next to the deployment, so the daily cap
 * survives a restart (G1-5) and an operator can read what the agent has spent without
 * running anything.
 *
 * Entries are append-only and carry no addresses — only when, how much, and which kind.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LedgerEntry, ledgerEntrySchema, withLock } from "@remit/core";
import { logEvent } from "./log.js";
import type { NetworkName } from "./networks.js";

/**
 * The ledger is there but cannot be read.
 *
 * Thrown rather than exited on, so that the rule is a property of the function and not of
 * the process it happens to be running in. `log.ts` turns anything that escapes a script
 * into one structured fatal line.
 */
export class UnreadableLedgerError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path} ${detail} — refusing to treat an unreadable ledger as an empty one`);
    this.name = "UnreadableLedgerError";
  }
}

/**
 * The entry went in and did not come back out.
 *
 * Only a concurrent writer can produce this: two appends that each read the same array
 * and each wrote the whole thing back, so one of them is gone. It is raised rather than
 * swallowed because the number it affects is the daily cap.
 */
export class LostLedgerEntryError extends Error {
  constructor(
    readonly path: string,
    expected: number,
    actual: number,
  ) {
    super(
      `${path} holds ${actual} entries after an append that should have left ` +
        `${expected} — the entry was overwritten by a concurrent writer, and the spend ` +
        "it recorded is not counted against the daily cap. Nothing else will notice.",
    );
    this.name = "LostLedgerEntryError";
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "..", "deployments");

function pathFor(network: NetworkName): string {
  return join(DIR, `${network}.ledger.json`);
}

/**
 * Read what the agent has already spent.
 *
 * A missing file is an empty ledger — the genesis case, and the only one that may answer
 * "nothing spent". A file that exists and does not parse is *not*: swallowing that would
 * hand G1 an empty ledger and silently restore the whole daily cap, which is the one way
 * this file can fail open. Truncating it would then be an attack rather than an accident.
 */
export function readLedger(network: NetworkName): readonly LedgerEntry[] {
  const path = pathFor(network);
  if (!existsSync(path)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new UnreadableLedgerError(path, `exists but is not JSON (${String(error)})`);
  }

  if (!Array.isArray(raw)) {
    throw new UnreadableLedgerError(
      path,
      "is not a ledger: expected an array of entries",
    );
  }

  const entries: LedgerEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = ledgerEntrySchema.safeParse(item);
    if (!parsed.success) {
      throw new UnreadableLedgerError(
        path,
        `entry ${index} is not a ledger entry: ` +
          `${parsed.error.issues[0]?.message ?? "unparseable"}`,
      );
    }
    entries.push(parsed.data);
  }

  return entries;
}

/**
 * Record what an action consumed.
 *
 * Written to a temporary file beside the ledger and renamed over it. An unreadable
 * ledger is now a hard failure rather than a silent zero, which is the right trade only
 * if a crash part-way through a write cannot produce one.
 */
export function appendLedger(
  network: NetworkName,
  entry: LedgerEntry,
): readonly LedgerEntry[] {
  // Read and write are one unit. Two writers that each read the file, each add their own
  // entry and each write the whole array back lose one of the two entries — and a lost
  // entry is spend the daily cap never sees again. The lock is the file the Python
  // bridge takes for the same write, so the two interlock rather than racing.
  return withLock(
    `${pathFor(network)}.lock`,
    () => {
      const entries = [...readLedger(network), ledgerEntrySchema.parse(entry)];
      mkdirSync(DIR, { recursive: true });

      const path = pathFor(network);
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`);
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }

      /**
       * Read it back, and say so if it is not there.
       *
       * The receipt chain has a second line of defence — `appendReceipt` creates its file
       * with `wx`, so two writers reaching the same sequence collide loudly. This has
       * none: it is a read-modify-write of one array, and a concurrent writer that read
       * the same starting state silently drops one of the two entries. A lost entry is
       * spend the daily cap never sees again, which is the failure that makes the cap
       * smaller than the operator set it and never announces itself.
       *
       * Cheap, and independent of whether the lock did its job — which is the point.
       */
      const written = readLedger(network);
      const last = written.at(-1);
      if (written.length !== entries.length || last?.at !== entry.at) {
        throw new LostLedgerEntryError(path, entries.length, written.length);
      }

      return entries;
    },
    {
      onLost: (holder) => {
        // Only reachable if something judged this process dead and took the lock while
        // it was inside. Whatever this append counted was counted against a history
        // somebody else may have been changing.
        logEvent("ledger.lock.lost", { network, holder });
      },
    },
  );
}
