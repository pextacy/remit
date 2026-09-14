/**
 * RM-5 — the Remit, signed by Safe owners, verified off chain.
 *
 * Nothing on chain checks these signatures, and that is deliberate: the on-chain truth is
 * the Roles preset, and a Remit can only narrow what the preset already grants (DOCS.md
 * §2.1). So what do they buy?
 *
 * They make the document *attributable*. Without them, a Remit is a file anyone with write
 * access could have produced — the hashes prove the file has not changed, not that an
 * owner ever agreed to it. With them, a receipt chain says which owners authorised the
 * authority under which a transaction happened, and an owner who disputes it has to
 * dispute their own signature.
 *
 * They are verified at startup rather than per action. A signature that is wrong is wrong
 * for every action, and checking it once is the difference between refusing to run and
 * refusing ten thousand times.
 */
import { type Address, getAddress, type Hex, recoverTypedDataAddress } from "viem";
import type { Remit } from "../schema/remit.js";
import { remitTypedData } from "./remit.js";

export type SignatureCheck = {
  readonly ok: boolean;
  /** Owners whose signature recovered correctly, deduplicated. */
  readonly valid: readonly Address[];
  /** Signatures that recovered to an address that is not a Safe owner. */
  readonly strangers: readonly Address[];
  /** Signatures that did not recover at all. */
  readonly malformed: number;
  readonly threshold: number;
  readonly reason: string;
};

/**
 * Check a Remit's signatures against the Safe's current owners.
 *
 * "Current" matters: owners change. A Remit signed by an owner who has since been removed
 * no longer carries that owner's authority, and saying so is the point of checking
 * against the chain rather than against a list in the file.
 */
export async function verifyRemitSignatures(input: {
  remit: Remit;
  signatures: readonly Hex[];
  owners: readonly Address[];
  threshold: number;
}): Promise<SignatureCheck> {
  const ownerSet = new Set(input.owners.map((owner) => getAddress(owner)));
  const typedData = remitTypedData(input.remit);

  const valid = new Set<Address>();
  const strangers: Address[] = [];
  let malformed = 0;

  for (const signature of input.signatures) {
    let recovered: Address;
    try {
      recovered = await recoverTypedDataAddress({ ...typedData, signature });
    } catch {
      malformed += 1;
      continue;
    }

    const address = getAddress(recovered);
    if (ownerSet.has(address)) {
      // A set, so one owner signing twice counts once. Otherwise a single key could
      // satisfy a 2-of-3 threshold by signing twice, which is the whole point of a
      // threshold not being satisfied.
      valid.add(address);
    } else {
      strangers.push(address);
    }
  }

  const met = valid.size >= input.threshold;
  const reason = met
    ? `${valid.size} of ${input.threshold} required owner signatures`
    : `${valid.size} valid owner signature(s), ${input.threshold} required`;

  return {
    ok: met && strangers.length === 0 && malformed === 0,
    valid: [...valid],
    strangers,
    malformed,
    threshold: input.threshold,
    reason:
      strangers.length > 0
        ? `${reason}; ${strangers.length} signature(s) are not from a current Safe owner`
        : malformed > 0
          ? `${reason}; ${malformed} signature(s) did not recover`
          : reason,
  };
}
