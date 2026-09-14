/**
 * The receipt chain: append, and verify.
 *
 * `verifyReceiptChain` is the one thing in this project a stranger runs. It re-derives
 * every hash from the bytes on disk — each receipt's `selfHash`, each `prevHash` link, and
 * `remitHash` and `limitsHash` from the stored Remit documents — and trusts nothing it was
 * told (PRD.md RC-3). Running it from a clean clone, by someone with no access to our
 * infrastructure, is acceptance criterion 3.
 *
 * Storage is one JSON file per receipt in a directory, named by sequence. Not a database:
 * a database is a thing you have to be given access to, and the point is that nobody needs
 * access to anything.
 */
import { type Hex, keccak256, toBytes } from "viem";
import { canonicalJson } from "../canonical/json.js";
import { remitDigest } from "../eip712/remit.js";
import { limitsHash, limitsSchema } from "../schema/limits.js";
import { remitSchema } from "../schema/remit.js";
import {
  GENESIS_PREV_HASH,
  type Receipt,
  type ReceiptBody,
  receiptSchema,
} from "./schema.js";

/** keccak256 over the canonical JSON of the body — every field except `selfHash`. */
export function receiptHash(body: ReceiptBody): Hex {
  return keccak256(toBytes(canonicalJson(body)));
}

/** Seal a body into a receipt. The hash is computed here and nowhere else. */
export function sealReceipt(body: ReceiptBody): Receipt {
  return receiptSchema.parse({ ...body, selfHash: receiptHash(body) });
}

export type ChainProblem = {
  readonly sequence: number;
  readonly file: string;
  readonly problem: string;
  readonly expected: string;
  readonly actual: string;
};

export type ChainVerification = {
  readonly ok: boolean;
  readonly count: number;
  /** The last `selfHash` — the value that anchors the whole chain. */
  readonly head: Hex;
  readonly problems: readonly ChainProblem[];
};

export type StoredReceipt = { readonly file: string; readonly receipt: unknown };

/**
 * The documents a receipt's hashes are supposed to commit to.
 *
 * Passing them in is what makes verification independent: the caller reads them off disk,
 * and this function re-derives the hashes rather than believing the ones in the receipt.
 */
export type RemitDocuments = {
  readonly remit: unknown;
  readonly limits: unknown;
};

export function verifyReceiptChain(
  stored: readonly StoredReceipt[],
  documents?: RemitDocuments,
): ChainVerification {
  const problems: ChainProblem[] = [];
  let previous: Hex = GENESIS_PREV_HASH;
  let head: Hex = GENESIS_PREV_HASH;

  // If the Remit documents are to hand, re-derive their hashes once, from the bytes.
  let expectedRemitHash: Hex | undefined;
  let expectedLimitsHash: Hex | undefined;
  if (documents !== undefined) {
    const remit = remitSchema.safeParse(documents.remit);
    const limits = limitsSchema.safeParse(documents.limits);
    if (remit.success) expectedRemitHash = remitDigest(remit.data);
    if (limits.success) expectedLimitsHash = limitsHash(limits.data);

    if (remit.success && limits.success) {
      const boundLimits = remit.data.limitsHash;
      const derived = limitsHash(limits.data);
      if (boundLimits !== derived) {
        problems.push({
          sequence: -1,
          file: "remit",
          problem: "the Remit binds a limitsHash the limits document does not produce",
          expected: boundLimits,
          actual: derived,
        });
      }
    }
  }

  stored.forEach((entry, index) => {
    const parsed = receiptSchema.safeParse(entry.receipt);
    if (!parsed.success) {
      problems.push({
        sequence: index,
        file: entry.file,
        problem: "receipt does not match the schema",
        expected: "a v1 receipt",
        actual: parsed.error.issues[0]?.message ?? "unparseable",
      });
      return;
    }

    const { selfHash, ...body } = parsed.data;
    const recomputed = receiptHash(body);

    if (recomputed !== selfHash) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "selfHash does not match the receipt's own bytes",
        expected: selfHash,
        actual: recomputed,
      });
    }

    if (body.sequence !== index) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "sequence is out of order — a record is missing or duplicated",
        expected: String(index),
        actual: String(body.sequence),
      });
    }

    if (body.prevHash !== previous) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "prevHash does not link to the previous receipt",
        expected: previous,
        actual: body.prevHash,
      });
    }

    if (expectedRemitHash !== undefined && body.remitHash !== expectedRemitHash) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "receipt references a Remit that the stored document does not produce",
        expected: expectedRemitHash,
        actual: body.remitHash,
      });
    }

    if (expectedLimitsHash !== undefined && body.limitsHash !== expectedLimitsHash) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "receipt references limits that the stored document does not produce",
        expected: expectedLimitsHash,
        actual: body.limitsHash,
      });
    }

    // A receipt claiming KeeperHub executed something must carry the execution id that
    // proves it. Without one there is nothing to correlate against, and an unverifiable
    // claim in an audit trail is worse than an honest gap.
    if (body.submission.path === "keeperhub" && body.submission.executionId === null) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "claims a KeeperHub submission with no executionId",
        expected: "an executionId",
        actual: "null",
      });
    }

    if (body.outcome === "executed" && body.action === null) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "claims an execution with no compiled action",
        expected: "an action",
        actual: "null",
      });
    }

    if (body.outcome === "executed" && body.submission.txHash === null) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem: "claims an execution with no transaction hash",
        expected: "a txHash",
        actual: "null",
      });
    }

    previous = selfHash;
    head = selfHash;
  });

  return { ok: problems.length === 0, count: stored.length, head, problems };
}
