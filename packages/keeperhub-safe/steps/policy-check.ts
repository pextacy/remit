import "server-only";

import { ethers } from "ethers";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getErrorMessage } from "@/lib/utils";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import {
  resolveRoleSigner,
  simulateAsRole,
  type PolicyCheckOutcome,
} from "./policy-check-core";

const PLUGIN_NAME = "safe";
const ACTION_NAME = "policy-check";
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const HEX_DATA_REGEX = /^0x([0-9a-fA-F]{2})*$/;

export type PolicyCheckInput = StepInput & {
  network: string;
  /** The contract the next node intends to call. */
  contractAddress: string;
  /** The calldata that node would send. */
  callData: string;
  /** Native value in wei, as a decimal string. Defaults to "0". */
  value?: string;
};

export type PolicyCheckResult =
  | {
      success: true;
      allowed: boolean;
      /** A named reason when `allowed` is false; empty when it is true. */
      reason: string;
      /** Structured kind, e.g. "role-condition-violation". */
      revertKind: string;
      /** The modifier's `Status` label when it refused on a condition. */
      status: string;
      /** True when the role refused, false when the inner call would fail anyway. */
      refusedByRole: boolean;
      gasEstimate: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

/**
 * A refusal is a successful check, not a failed step. The workflow author decides what
 * to do about it — branch, alert, stop — and a node that threw would take that choice
 * away and retry a decision the chain has already made.
 */
function refused(outcome: Extract<PolicyCheckOutcome, { allowed: false }>): PolicyCheckResult {
  return {
    success: true,
    allowed: false,
    reason: outcome.reason,
    revertKind: outcome.revert.kind,
    status:
      outcome.revert.kind === "role-condition-violation" ? outcome.revert.status : "",
    refusedByRole: outcome.refusedByRole,
    gasEstimate: "0",
  };
}

async function stepHandler(input: PolicyCheckInput): Promise<PolicyCheckResult> {
  const organizationId = input._context?.organizationId;
  if (!organizationId) {
    return {
      success: false,
      error: "No organization context; the signer mode cannot be resolved.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  if (!ETH_ADDRESS_REGEX.test(input.contractAddress)) {
    return {
      success: false,
      error: `contractAddress must be a 0x-prefixed 20-byte address, got "${input.contractAddress}".`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  if (!HEX_DATA_REGEX.test(input.callData)) {
    return {
      success: false,
      error: "callData must be 0x-prefixed hex with an even number of digits.",
      errorClass: ExecutionErrorType.USER,
    };
  }

  let value: bigint;
  try {
    value = BigInt(input.value ?? "0");
  } catch {
    return {
      success: false,
      error: `value must be a decimal string of wei, got "${input.value}".`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  let chainId: number;
  try {
    // Synchronous upstream: it throws on an unknown network rather than resolving.
    chainId = getChainIdFromNetwork(input.network);
  } catch (error) {
    return {
      success: false,
      error: `Unknown network "${input.network}": ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const signer = await resolveRoleSigner(organizationId, chainId);
  if ("error" in signer) {
    return { success: false, error: signer.error, errorClass: ExecutionErrorType.USER };
  }

  try {
    const outcome = await simulateAsRole(signer, {
      organizationId,
      chainId,
      to: ethers.getAddress(input.contractAddress),
      data: input.callData,
      value,
    });

    if (!outcome.allowed) {
      return refused(outcome);
    }

    return {
      success: true,
      allowed: true,
      reason: "",
      revertKind: "",
      status: "",
      refusedByRole: false,
      gasEstimate: outcome.gasEstimate ?? "0",
    };
  } catch (error) {
    // An RPC that could not be reached is not a policy answer. Returning "allowed" here
    // would turn an outage into a green light, and returning "refused" would stop a
    // workflow the role would have permitted.
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "Safe policy check could not reach the chain",
      error,
      {
        plugin_name: PLUGIN_NAME,
        action_name: ACTION_NAME,
        service: "rpc",
      }
    );
    return {
      success: false,
      error: `Policy check could not reach the chain: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

export async function policyCheckStep(
  input: PolicyCheckInput
): Promise<PolicyCheckResult> {
  "use step";

  return runPluginStep(
    { pluginName: PLUGIN_NAME, actionName: ACTION_NAME },
    input,
    () => stepHandler(input)
  );
}

// A policy answer is a point-in-time reading of on-chain state. Retrying it silently
// would report an allowance or a membership that changed between attempts.
policyCheckStep.maxRetries = 0;

export const _integrationType = "safe";
