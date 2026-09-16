/**
 * RM-4 — the bridge refuses to start if the Remit and the chain disagree.
 *
 * A Remit is a declaration; the Roles preset is the authority. The declaration can only
 * ever narrow what the preset grants, and the moment the two describe different things
 * the Remit stops meaning anything: an operator reading `allowedRecipients: [the Safe]`
 * would believe a guarantee the chain is not making.
 *
 * So this runs before a strategy is allowed to propose anything, and it compares three
 * documents rather than two — the limits the Remit binds, the preset those limits imply,
 * and what the chain actually says. Drift in any pair stops the run.
 */
import type { Address, Hex, PublicClient } from "viem";
import { getAddress, toFunctionSelector } from "viem";
import { safeAbi } from "../chain/abi/safe.js";
import type { SupportedChainId } from "../chain/addresses.js";
import { Clearance } from "../chain/roles-enums.js";
import { verifyRemitSignatures } from "../eip712/signatures.js";
import { type Limits, limitsHash } from "../schema/limits.js";
import type { Remit } from "../schema/remit.js";
import { type Delta, diffRole } from "./diff.js";
import { type OnChainRole, readRole } from "./onchain.js";
import { buildPreset } from "./preset.js";

export type DriftFinding = {
  readonly code:
    | "REMIT_PRESET_DRIFT"
    | "REMIT_LIMITS_MISMATCH"
    | "REMIT_TARGET_NOT_SCOPED"
    | "REMIT_SELECTOR_NOT_SCOPED"
    | "REMIT_TARGET_OVER_CLEARED"
    | "REMIT_AGENT_NOT_MEMBER"
    | "REMIT_EXTRA_ROLE_MEMBER"
    | "REMIT_SIGNATURES_INVALID";
  readonly detail: string;
};

export type DriftCheck = {
  readonly ok: boolean;
  readonly findings: readonly DriftFinding[];
  readonly deltas: readonly Delta[];
  readonly asOfBlock: string;
  readonly eventsReplayed: number;
};

export type DriftInput = {
  readonly client: PublicClient;
  readonly chainId: SupportedChainId;
  readonly remit: Remit;
  readonly limits: Limits;
  readonly rolesModifier: Address;
  readonly agent: Address;
  readonly fromBlock?: bigint;
  /**
   * Owner signatures over the Remit, if it carries any (RM-5).
   *
   * Optional, because an unsigned Remit is still usable — the preset is the authority
   * either way. But a Remit that carries signatures which do not verify is worse than an
   * unsigned one: it claims an approval nobody gave.
   */
  readonly signatures?: readonly Hex[];
};

export async function checkPresetDrift(input: DriftInput): Promise<DriftCheck> {
  const findings: DriftFinding[] = [];

  // 1. The limits document must be the one the Remit binds. Everything below reasons
  //    about these limits, so if they are not the bound ones, nothing below is evidence.
  const derived = limitsHash(input.limits);
  if (derived !== input.remit.limitsHash) {
    findings.push({
      code: "REMIT_LIMITS_MISMATCH",
      detail: `the limits document hashes to ${derived}, the Remit binds ${input.remit.limitsHash}`,
    });
  }

  const onChain: OnChainRole = await readRole(
    input.client,
    input.rolesModifier,
    input.remit.roleKey,
    input.fromBlock === undefined ? {} : { fromBlock: input.fromBlock },
  );

  // 2. The agent must actually be in the role. A Remit over a role nobody is in is a
  //    document about nothing — and this is also how a pulled kill switch shows up.
  const agent = getAddress(input.agent);
  if (onChain.members.get(agent) !== true) {
    findings.push({
      code: "REMIT_AGENT_NOT_MEMBER",
      detail: `${input.agent} is not a member of ${input.remit.roleKey} on chain`,
    });
  }

  /**
   * 2b. And nobody else may be.
   *
   * Every check below this one reasons about what *the agent* may do. A second member
   * holds the identical preset, is named by no Remit and no receipt, and is revoked by
   * nothing: the kill switch acts on the agent this deployment recorded, so pulling it
   * reports success while the other address keeps the whole authority.
   *
   * It is the drift that leaves the preset itself spotless, which is why checking the
   * preset alone never found it.
   */
  const extra = [...onChain.members.entries()]
    .filter(([member, isMember]) => isMember && member !== agent)
    .map(([member]) => member);

  if (extra.length > 0) {
    findings.push({
      code: "REMIT_EXTRA_ROLE_MEMBER",
      detail:
        `${extra.length} address(es) other than the agent are members of ` +
        `${input.remit.roleKey}: ${extra.join(", ")}. Each holds this preset in full, ` +
        "and the kill switch does not revoke any of them.",
    });
  }

  // 3. Everything the limits permit must be scoped on chain, and scoped no wider.
  const selectors = new Set(
    input.limits.allowedSelectors.map((signature) => toFunctionSelector(signature)),
  );

  for (const target of input.limits.allowedTargets) {
    const address = getAddress(target);
    const scoped = onChain.targets.get(address);

    if (scoped === undefined || scoped.clearance === Clearance.None) {
      findings.push({
        code: "REMIT_TARGET_NOT_SCOPED",
        detail: `the Remit allows calls to ${address}, the chain does not`,
      });
      continue;
    }

    // `Clearance.Target` means *every* function on that contract. A Remit that lists
    // three selectors over a target cleared like that is describing a fence that is not
    // there.
    if (scoped.clearance === Clearance.Target) {
      findings.push({
        code: "REMIT_TARGET_OVER_CLEARED",
        detail:
          `${address} is cleared on chain at target level — every function on it is ` +
          "callable — while the Remit lists specific selectors",
      });
      continue;
    }

    for (const selector of selectors) {
      const scopedFunction = scoped.functions.get(selector as Hex);
      if (scopedFunction === undefined) continue; // not this target's selector
      if (scopedFunction.conditions === undefined) {
        findings.push({
          code: "REMIT_SELECTOR_NOT_SCOPED",
          detail:
            `${selector} on ${address} is allowed on chain with no parameter conditions; ` +
            "the Remit's recipient limits are not enforced by anything",
        });
      }
    }
  }

  // 3b. If the Remit claims owner approval, that claim has to hold — against the Safe's
  //     *current* owners, because owners change and a signature from a removed owner no
  //     longer carries their authority.
  if (input.signatures !== undefined && input.signatures.length > 0) {
    const owners = (await input.client.readContract({
      address: input.remit.safe,
      abi: safeAbi,
      functionName: "getOwners",
    })) as readonly Address[];
    const threshold = Number(
      (await input.client.readContract({
        address: input.remit.safe,
        abi: safeAbi,
        functionName: "getThreshold",
      })) as bigint,
    );

    const check = await verifyRemitSignatures({
      remit: input.remit,
      signatures: input.signatures,
      owners: [...owners],
      threshold,
    });

    if (!check.ok) {
      findings.push({ code: "REMIT_SIGNATURES_INVALID", detail: check.reason });
    }
  }

  // 4. The preset those limits imply, against the chain. This is the structural check
  //    `roles:diff` prints; here it is a yes-or-no.
  const preset = buildPreset(input.chainId, input.remit.roleKey);
  const deltas = diffRole(preset, onChain);

  if (deltas.length > 0) {
    findings.push({
      code: "REMIT_PRESET_DRIFT",
      detail: `${deltas.length} difference(s) between the preset and the chain: ${deltas
        .map((delta) => `${delta.kind} ${delta.subject}`)
        .join("; ")}`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    deltas,
    asOfBlock: onChain.asOfBlock.toString(),
    eventsReplayed: onChain.eventsReplayed,
  };
}
