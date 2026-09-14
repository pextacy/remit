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
import {
  type ChainVerification,
  type RemitDocuments,
  type StoredReceipt,
  sealReceipt,
  verifyReceiptChain,
} from "./chain.js";
import { GENESIS_PREV_HASH, type Receipt, type ReceiptBody } from "./schema.js";

const FILE_PATTERN = /^(\d{4})-.+\.json$/;

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
export function readChain(dir: string): readonly StoredReceipt[] {
  if (!existsSync(dir)) throw new MissingChainError(dir);

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => FILE_PATTERN.test(name))
    .sort()
    .map((name) => ({
      file: name,
      receipt: JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown,
    }));
}

export function chainHead(dir: string): { sequence: number; prevHash: `0x${string}` } {
  const stored = readChain(dir);
  const last = stored.at(-1);
  if (last === undefined) return { sequence: 0, prevHash: GENESIS_PREV_HASH };

  const receipt = last.receipt as Receipt;
  return { sequence: receipt.sequence + 1, prevHash: receipt.selfHash };
}

/**
 * Append a receipt.
 *
 * `sequence` and `prevHash` are filled in here from what is already on disk, never by the
 * caller: a caller that can choose its own place in the chain can rewrite history without
 * the chain noticing.
 */
export function appendReceipt(
  dir: string,
  body: Omit<ReceiptBody, "sequence" | "prevHash">,
): { receipt: Receipt; file: string } {
  const head = chainHead(dir);
  const receipt = sealReceipt({
    ...body,
    sequence: head.sequence,
    prevHash: head.prevHash,
  });

  mkdirSync(dir, { recursive: true });
  const file = `${String(receipt.sequence).padStart(4, "0")}-${receipt.outcome}.json`;
  writeFileSync(join(dir, file), `${JSON.stringify(receipt, null, 2)}\n`);

  return { receipt, file };
}

export function verifyChainAt(
  dir: string,
  documents?: RemitDocuments,
): ChainVerification {
  return verifyReceiptChain(readChain(dir), documents);
}
