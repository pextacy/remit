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
  receiptBodySchema,
  receiptSchema,
} from "./schema.js";

/** keccak256 over the canonical JSON of the body — every field except `selfHash`. */
export function receiptHash(body: ReceiptBody): Hex {
  return keccak256(toBytes(canonicalJson(body)));
}

/**
 * Seal a body into a receipt. The hash is computed here and nowhere else.
 *
 * The body is parsed *before* it is hashed, and the parsed form is what gets written.
 * The schemas normalise — an address is checksummed, a bytes32 is lowercased — and
 * verification re-derives the hash from the parsed file. Hashing the caller's spelling
 * instead would seal a receipt whose own `selfHash` failed to reproduce the moment a
 * caller handed in an uppercase hash, which is a chain that breaks for no reason anyone
 * could find.
 */
export function sealReceipt(body: ReceiptBody): Receipt {
  const normalised = receiptBodySchema.parse(body);
  return receiptSchema.parse({ ...normalised, selfHash: receiptHash(normalised) });
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
  /**
   * Receipts written under a Remit other than the one supplied.
   *
   * Not a problem, and saying so matters. A Remit expires, and the instruction when it
   * does is to *reissue* it rather than widen it — so a chain that has been running for
   * longer than one Remit's life legitimately contains receipts naming two or three of
   * them. Calling those a broken chain made "the receipts verify" false for every
   * deployment that had ever done the right thing, which is a verifier that trains its
   * reader to ignore it.
   *
   * The integrity of those records is checked exactly as hard as any other: their own
   * `selfHash`, their sequence and their `prevHash` link. What cannot be checked is the
   * one thing the supplied documents do not describe — which is what this field reports.
   */
  readonly uncheckedAgainstDocuments: readonly {
    readonly sequence: number;
    readonly file: string;
    readonly remitHash: Hex;
  }[];
};

export type StoredReceipt = {
  readonly file: string;
  readonly receipt: unknown;
  /**
   * Why the file could not be read at all, when it could not.
   *
   * A truncated or hand-edited file is a problem to report, not an exception to throw:
   * a verifier that dies on the first bad record tells you less than one that finishes
   * and lists every record it could not account for.
   */
  readonly unreadable?: string;
};

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
  const uncheckedAgainstDocuments: {
    sequence: number;
    file: string;
    remitHash: Hex;
  }[] = [];
  let previous: Hex = GENESIS_PREV_HASH;
  let head: Hex = GENESIS_PREV_HASH;
  /** Did any record in this chain actually happen under the Remit we were handed? */
  let matchedTheDocuments = false;
  /** When the newest readable record was written. Zero for a chain with none. */
  let newestAt = 0;

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
    if (entry.unreadable !== undefined) {
      problems.push({
        sequence: index,
        file: entry.file,
        problem: "the file could not be read",
        expected: "a v1 receipt",
        actual: entry.unreadable,
      });
      return;
    }

    const parsed = receiptSchema.safeParse(entry.receipt);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push({
        sequence: index,
        file: entry.file,
        problem: "receipt does not match the schema",
        expected: "a v1 receipt",
        actual:
          issue === undefined
            ? "unparseable"
            : `${issue.path.length === 0 ? "receipt" : issue.path.join(".")}: ${issue.message}`,
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

    // A receipt either names the Remit we were handed, or it names another one.
    //
    // If it names ours, its `limitsHash` has to be the one that Remit binds — a record
    // claiming this authority under different limits is the forgery this check exists to
    // catch, and it is a hard failure.
    //
    // If it names another, there is nothing here to check it against. That is the normal
    // state of any chain older than one Remit: expiry is answered by reissuing, so a
    // long-lived deployment's chain spans several. Reporting those as broken made the
    // verifier's answer "no" for every deployment that had done the right thing.
    if (expectedRemitHash !== undefined && body.remitHash !== expectedRemitHash) {
      uncheckedAgainstDocuments.push({
        sequence: body.sequence,
        file: entry.file,
        remitHash: body.remitHash,
      });
    } else if (expectedRemitHash !== undefined) {
      matchedTheDocuments = true;
    }

    if (
      expectedRemitHash !== undefined &&
      body.remitHash === expectedRemitHash &&
      expectedLimitsHash !== undefined &&
      body.limitsHash !== expectedLimitsHash
    ) {
      problems.push({
        sequence: body.sequence,
        file: entry.file,
        problem:
          "receipt claims this Remit but references limits the Remit does not bind",
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

    if (body.at > newestAt) newestAt = body.at;
    previous = selfHash;
    head = selfHash;
  });

  // Documents that describe an authority this chain never used are almost certainly the
  // wrong documents — a path typo, or last quarter's Remit. `unchecked` has to mean
  // history rather than "we verified nothing against these and said yes".
  //
  // With one exception, and it is a normal state rather than a corner: a Remit issued and
  // not yet acted under. Its `notBefore` is later than anything in the chain, so it could
  // not have produced a record here, and calling that a broken chain would make `verify`
  // answer "no" in the minutes between reissuing a Remit and using it — the same false
  // alarm as reporting a reissue itself.
  //
  // A Remit that *was* in force while this chain was being written and is named by
  // nothing in it is the wrong document, and that is what this catches.
  if (expectedRemitHash !== undefined && stored.length > 0 && !matchedTheDocuments) {
    const remit = remitSchema.safeParse(documents?.remit);
    const issuedAfterTheChain = remit.success && remit.data.notBefore >= newestAt;

    if (!issuedAfterTheChain) {
      problems.push({
        sequence: -1,
        file: "remit",
        problem:
          "no receipt in this chain was written under the Remit supplied, and it was " +
          "in force while the chain was",
        expected: expectedRemitHash,
        actual:
          uncheckedAgainstDocuments.length === 0
            ? "a chain with no readable records"
            : `${uncheckedAgainstDocuments.length} receipt(s), all under other Remits`,
      });
    }
  }

  return {
    ok: problems.length === 0,
    count: stored.length,
    head,
    problems,
    uncheckedAgainstDocuments,
  };
}
