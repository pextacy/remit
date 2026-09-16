/**
 * Loading the issued Remit, and refusing to act on a different one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Limits,
  limitsSchema,
  type Remit,
  remitDigest,
  remitSchema,
} from "@remit/core";
import type { Hex } from "viem";
import { fail } from "./log.js";
import type { NetworkName } from "./networks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..", "..");
export const RECEIPTS_ROOT = join(REPO, "receipts");
/** The G3 queue: pending items the console shows, decisions it writes back. */
export const REVIEW_ROOT = join(REPO, "ops", "review");

export type LoadedRemit = {
  readonly remit: Remit;
  readonly limits: Limits;
  readonly remitHash: Hex;
  /**
   * Owner signatures, if `remit:sign` has been run (RM-5).
   *
   * They were written to this file and then read by nothing on the ops side, so the
   * mainnet path could not tell a Remit its owners had approved from one anybody with
   * write access had produced. Carried here so the path that spends real money can check
   * them against the Safe's *current* owners.
   */
  readonly signatures: readonly Hex[];
};

export function loadRemit(network: NetworkName): LoadedRemit {
  let raw: { remit: unknown; limits: unknown; remitHash?: Hex; signatures?: unknown };
  try {
    raw = JSON.parse(
      readFileSync(join(REPO, "ops", "remits", `${network}.json`), "utf8"),
    ) as typeof raw;
  } catch {
    return fail(`no Remit at ops/remits/${network}.json — run remit:issue first`);
  }

  const remit = remitSchema.parse(raw.remit);
  const limits = limitsSchema.parse(raw.limits);
  // Re-derived rather than trusted: the file's own claim about its hash is the one thing
  // in it that nothing else checks.
  const remitHash = remitDigest(remit);

  if (raw.remitHash !== undefined && raw.remitHash !== remitHash) {
    fail(
      `ops/remits/${network}.json says its remitHash is ${raw.remitHash}, but the ` +
        `document hashes to ${remitHash} — the file was edited after it was issued`,
    );
  }

  // Shape-checked here rather than trusted: they are handed to `recoverTypedDataAddress`,
  // and a value that is not a hex signature would throw inside the check instead of
  // failing it — which reads as a crash rather than as a Remit nobody signed.
  const signatures = Array.isArray(raw.signatures)
    ? raw.signatures.filter(
        (signature): signature is Hex =>
          typeof signature === "string" && /^0x[0-9a-fA-F]+$/.test(signature),
      )
    : [];

  if (Array.isArray(raw.signatures) && signatures.length !== raw.signatures.length) {
    fail(
      `ops/remits/${network}.json carries ${raw.signatures.length} signature(s), of ` +
        `which ${raw.signatures.length - signatures.length} are not signatures. A Remit ` +
        "that claims an approval nobody can check is worse than an unsigned one.",
    );
  }

  return { remit, limits, remitHash, signatures };
}

/** Refuse to act unless the operator named the Remit they meant. */
export function requireRemitHash(
  loaded: LoadedRemit,
  expected: string | undefined,
): void {
  if (expected === undefined) {
    fail(
      "--remit <hash> is required here: naming the Remit is how an operator says which " +
        `authority they are acting under. This deployment's is ${loaded.remitHash}`,
    );
  }
  if (expected.toLowerCase() !== loaded.remitHash.toLowerCase()) {
    fail(
      `--remit ${expected} does not match the Remit issued for this network ` +
        `(${loaded.remitHash}) — nothing was sent`,
    );
  }
}
