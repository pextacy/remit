/**
 * Receipts on disk.
 *
 * One file per receipt, named by sequence and outcome, in a directory per network. A
 * directory of JSON files is the whole storage layer on purpose: `git log` is the audit
 * trail, `diff` is the reconciliation tool, and a stranger with a clone needs no
 * credentials to check any of it.
 *
 * `chain.ts` stays pure and takes the records as data; this is the only part that touches
 * a filesystem.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../util/lock.js";
import {
  type ChainVerification,
  type RemitDocuments,
  type StoredReceipt,
  sealReceipt,
  verifyReceiptChain,
} from "./chain.js";
import {
  GENESIS_PREV_HASH,
  type Receipt,
  type ReceiptBody,
  receiptSchema,
} from "./schema.js";

/**
 * `NNNN-outcome.json`, with **at least** four digits.
 *
 * It was exactly four, and `appendReceipt` pads to a minimum of four rather than a
 * maximum — so the ten-thousandth receipt is written as `10000-executed.json`, which the
 * old pattern did not match. Every record from that one on became invisible: `verify`
 * re-derived the first ten thousand hashes, found them all sound and answered *yes* to a
 * chain it had not read the end of, and the next append reused a sequence until it hit
 * the exclusive create. A verifier that passes on a truncated chain is the one failure
 * this file may not have, and it arrives silently at a round number.
 */
const FILE_PATTERN = /^(\d{4,})-.+\.json$/;

/**
 * The sequence a receipt's filename claims, or `undefined` if it claims none.
 *
 * Read so the chain can be ordered by *number*. Sorting the names as strings put
 * `10000-…` before `9999-…`, which is the same off-by-a-power-of-ten as the pattern
 * above and produces a chain whose `prevHash` links all fail at once rather than a
 * chain that is quietly short.
 */
function sequenceOf(name: string): number | undefined {
  const matched = FILE_PATTERN.exec(name);
  return matched?.[1] === undefined ? undefined : Number(matched[1]);
}

export class MissingChainError extends Error {
  constructor(readonly dir: string) {
    super(`no receipt directory at ${dir}`);
    this.name = "MissingChainError";
  }
}

/**
 * Read a chain off disk.
 *
 * A directory that does not exist and a directory with no receipts in it are different
 * facts, and conflating them makes verification pass on a path typo — which is the one
 * failure a verifier must never have.
 */
export function readChain(
  dir: string,
  options: { allowMissing?: boolean } = {},
): readonly StoredReceipt[] {
  if (!existsSync(dir)) {
    // Appending to a chain that does not exist yet is the genesis case and must work.
    // Verifying one that does not exist is a path typo, and must not.
    if (options.allowMissing === true) return [];
    throw new MissingChainError(dir);
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .map((name) => ({ name, sequence: sequenceOf(name) }))
    .filter(
      (entry): entry is { name: string; sequence: number } =>
        entry.sequence !== undefined,
    )
    .sort((a, b) => a.sequence - b.sequence || (a.name < b.name ? -1 : 1))
    .map(({ name }) => {
      try {
        return {
          file: name,
          receipt: JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown,
        };
      } catch (error) {
        // Handed on rather than thrown. The verifier's job is to finish and say what is
        // wrong with the chain, and "this file is not JSON" is one of the things that can
        // be wrong with it — losing the other records to report it would be a poor trade.
        return {
          file: name,
          receipt: undefined,
          unreadable: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

export class BrokenChainError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(`${file} is not a readable receipt: ${detail}`);
    this.name = "BrokenChainError";
  }
}

/**
 * Where the next receipt goes.
 *
 * The head is parsed rather than cast. A corrupt or hand-edited last record would
 * otherwise hand back `NaN` for the sequence and `undefined` for the link, and the next
 * append would either throw somewhere unrelated or start a second chain beside the
 * first. Refusing to append onto a head nobody can read is the honest failure.
 */
export function chainHead(dir: string): { sequence: number; prevHash: `0x${string}` } {
  const stored = readChain(dir, { allowMissing: true });
  const last = stored.at(-1);
  if (last === undefined) return { sequence: 0, prevHash: GENESIS_PREV_HASH };

  if (last.unreadable !== undefined)
    throw new BrokenChainError(last.file, last.unreadable);

  const parsed = receiptSchema.safeParse(last.receipt);
  if (!parsed.success) {
    throw new BrokenChainError(
      last.file,
      parsed.error.issues[0]?.message ?? "does not match the receipt schema",
    );
  }

  const receipt: Receipt = parsed.data;
  return { sequence: receipt.sequence + 1, prevHash: receipt.selfHash };
}

export class ReceiptCollisionError extends Error {
  constructor(readonly file: string) {
    super(
      `${file} already exists — refusing to overwrite a receipt. Two writers reached ` +
        "the same sequence, and the record already on disk is the one somebody's " +
        "prevHash points at.",
    );
    this.name = "ReceiptCollisionError";
  }
}

/**
 * Append a receipt.
 *
 * `sequence` and `prevHash` are filled in here from what is already on disk, never by the
 * caller: a caller that can choose its own place in the chain can rewrite history without
 * the chain noticing.
 *
 * Reading the head and writing the record are one unit, under a lock the bridge and the
 * ops scripts share. Without it, two processes appending at once both read sequence 7,
 * both seal a receipt claiming it, and the second silently replaces the first — a chain
 * that still verifies and is missing a record, which is the one failure a receipt chain
 * may not have. The exclusive create is the second line of defence: if the lock is ever
 * wrong, the append fails loudly rather than overwriting.
 */
export function appendReceipt(
  dir: string,
  body: Omit<ReceiptBody, "sequence" | "prevHash">,
): { receipt: Receipt; file: string } {
  return withLock(join(dir, ".append.lock"), () => {
    const head = chainHead(dir);
    const receipt = sealReceipt({
      ...body,
      sequence: head.sequence,
      prevHash: head.prevHash,
    });

    mkdirSync(dir, { recursive: true });
    const file = `${String(receipt.sequence).padStart(4, "0")}-${receipt.outcome}.json`;
    try {
      writeFileSync(join(dir, file), `${JSON.stringify(receipt, null, 2)}\n`, {
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ReceiptCollisionError(file);
      }
      throw error;
    }

    return { receipt, file };
  });
}

export function verifyChainAt(
  dir: string,
  documents?: RemitDocuments,
): ChainVerification {
  return verifyReceiptChain(readChain(dir), documents);
}
