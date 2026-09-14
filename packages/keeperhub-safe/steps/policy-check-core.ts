import "server-only";

import { ethers } from "ethers";
import { buildExecTransactionWithRoleCalldata } from "@/lib/safe/zodiac-roles";
import { resolveSignerMode, type SignerMode } from "@/lib/safe/signer-resolver";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { classifyRevert, formatContractError } from "@/lib/web3/decode-revert-error";

/**
 * Would the Roles modifier allow this call, if we sent it?
 *
 * `lib/execute/simulate.ts` answers a nearby question and says so in its own docstring:
 *
 *   > Known limitation: `from` is resolved via getOrganizationWalletAddress (the org's
 *   > EOA / smart account address). Orgs that route writes through a Safe will produce a
 *   > simulation that reflects the EOA sending the call, not the Safe.
 *
 * For a `safe-role` org that leaves two gaps. The simulated `msg.sender` is the EOA rather
 * than the Safe, so allowance and balance checks inside the target are answered about the
 * wrong account; and the Roles modifier is not in the simulated path at all, so a call the
 * role forbids simulates clean and then reverts on chain. The refusal is decoded
 * afterwards, by `classifyRevert`, once the gas is spent.
 *
 * This simulates the outer call instead — `execTransactionWithRole(...)` with
 * `shouldRevert = true`, `eth_call`, from the delegate EOA — so the preflight and the
 * broadcast take the same path through the same contract, and a refusal comes back as a
 * named `Status` before anything is spent.
 *
 * Shared logic lives here rather than in the step file so the step file exports nothing
 * but its step function (`plugins/CLAUDE.md`, step file rule 2).
 */

export type PolicyCheckOutcome =
  | {
      allowed: true;
      /** Gas the call would consume if it were sent. Zero when unavailable. */
      gasEstimate: string | null;
    }
  | {
      allowed: false;
      /** A named reason, never an undecoded `0x…` blob. */
      reason: string;
      /** The structured classification, for callers that branch on it. */
      revert: ReturnType<typeof classifyRevert>;
      /** True when the role itself refused, rather than the inner call failing. */
      refusedByRole: boolean;
    };

export type PolicyCheckArgs = {
  organizationId: string;
  chainId: number;
  /** The contract the workflow wants to call. */
  to: string;
  /** Calldata for that contract, as the write step would build it. */
  data: string;
  /** Native value. Roles scoped with `ExecutionOptions.None` refuse any non-zero value. */
  value?: bigint;
};

/**
 * Refusals that come from the modifier, as opposed to the inner call failing for its own
 * reasons. The distinction matters to an operator: the first means "the role does not
 * permit this", the second means "the role permits it and it would fail anyway".
 */
const ROLE_REFUSAL_KINDS = new Set([
  "role-condition-violation",
  "role-not-authorized",
]);

export function isRoleRefusal(revert: ReturnType<typeof classifyRevert>): boolean {
  return ROLE_REFUSAL_KINDS.has(revert.kind);
}

/** A sentence an operator can act on, built from the structured classification. */
export function describeRefusal(
  revert: ReturnType<typeof classifyRevert>,
  error: unknown
): string {
  switch (revert.kind) {
    case "role-condition-violation":
      return `The role's policy refused this call: ${revert.status} (status ${revert.statusCode}, ${revert.paramOrKey}).`;
    case "role-not-authorized":
      return `The delegate ${revert.account ?? "signer"} is not a member of this role.`;
    case "erc20-insufficient-allowance":
      return `The role would allow this call, but the token allowance is ${revert.allowance} and the call needs ${revert.needed}.`;
    case "erc20-insufficient-balance":
      return `The role would allow this call, but the balance is ${revert.balance} and the call needs ${revert.needed}.`;
    case "string-revert":
      return `The call would revert: ${revert.reason}`;
    case "contract-custom":
      return `The call would revert with ${revert.name}.`;
    default:
      // Never a bare hex blob: a preflight whose answer is `0x…` has told the operator
      // nothing, which is the failure mode this step exists to remove.
      return `The call would revert: ${formatContractError(error)}`;
  }
}

export type ResolvedRoleSigner = Extract<SignerMode, { kind: "safe-role" }>;

/**
 * The org must actually be routing through a Roles modifier for this question to have an
 * answer. An `eoa` or plain `safe` org gets told so rather than a misleading "allowed".
 */
export async function resolveRoleSigner(
  organizationId: string,
  chainId: number
): Promise<ResolvedRoleSigner | { error: string }> {
  const mode = await resolveSignerMode(organizationId, chainId, {
    // A preflight is not production execution; counting it would inflate the resolver's
    // signer-mode distribution, which the editor preflight already opts out of.
    recordMetrics: false,
  });

  if (mode.kind !== "safe-role") {
    return {
      error:
        `This organization signs as "${mode.kind}" on chain ${chainId}, not through a ` +
        "Zodiac Roles modifier, so there is no role policy to check. Install a role on " +
        "the Safe first, or drop this node from the workflow.",
    };
  }

  return mode;
}

export async function simulateAsRole(
  signer: ResolvedRoleSigner,
  args: PolicyCheckArgs
): Promise<PolicyCheckOutcome> {
  const calldata = buildExecTransactionWithRoleCalldata({
    to: args.to,
    // `BigInt(0)`, not `0n`: the repository targets ES2017 and rejects BigInt literals.
    value: args.value ?? BigInt(0),
    data: args.data,
    roleKey: signer.roleKey,
    // The modifier returns success as a boolean unless asked to revert. Asking it to
    // revert is what turns a silent `false` into a decodable reason.
    shouldRevert: true,
  });

  // No `userId`: `StepContext` does not carry one, and a preflight is an
  // organization-level question rather than a per-user one.
  const rpcManager = await getRpcProvider({ chainId: args.chainId });

  const request = {
    from: signer.delegateAddress,
    to: signer.rolesModifierAddress,
    data: calldata,
  };

  try {
    // `eth_call` first: it is the question being asked, and it costs nothing whatever the
    // answer. Routed through failover so a primary-RPC blip does not read as a refusal.
    await rpcManager.executeWithFailover((provider: ethers.JsonRpcProvider) =>
      provider.call(request)
    );
  } catch (error) {
    const revert = classifyRevert(error);
    return {
      allowed: false,
      reason: describeRefusal(revert, error),
      revert,
      refusedByRole: isRoleRefusal(revert),
    };
  }

  // The call passes. A gas figure is useful to the workflow author and is never the
  // reason to fail the check — an estimate that cannot be produced is not a refusal.
  let gasEstimate: string | null = null;
  try {
    const gas = await rpcManager.executeWithFailover((provider: ethers.JsonRpcProvider) =>
      provider.estimateGas(request)
    );
    gasEstimate = gas.toString();
  } catch {
    gasEstimate = null;
  }

  return { allowed: true, gasEstimate };
}
