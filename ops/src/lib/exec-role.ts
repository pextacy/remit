/**
 * The two halves of acting under a role: ask first, then act.
 *
 * `preflight` is `eth_call` on `execTransactionWithRole` with `shouldRevert = true`, from
 * the agent signer, against the Roles Modifier. It costs no gas whatever the answer, and
 * a refusal comes back as a name. This is the shape G2 takes in P3; keeping it in one
 * place means the gate and the operator tooling cannot drift apart.
 *
 * `executeThroughRole` sends the same call for real. Nothing in this repository has any
 * other way to move value out of the Safe.
 */

import {
  type DecodedRevert,
  decodeRevert,
  formatRevert,
  isUndecodable,
  Operation,
  rolesAbi,
} from "@remit/core";
import { type Address, encodeFunctionData, type Hex } from "viem";
import { publicClientFor, type Sender, type SendResult, sendTx } from "./clients.js";
import { logEvent } from "./log.js";
import type { Network } from "./networks.js";

export type RoleAction = {
  /** What a human calls it. Goes in the log line and, in P3, in the receipt. */
  readonly label: string;
  readonly target: Address;
  readonly data: Hex;
};

export type Preflight =
  | { readonly ok: true }
  | { readonly ok: false; readonly decoded: DecodedRevert; readonly reason: string };

export async function preflight(
  network: Network,
  rolesModifier: Address,
  roleKey: Hex,
  agent: Address,
  action: RoleAction,
): Promise<Preflight> {
  try {
    await publicClientFor(network).simulateContract({
      address: rolesModifier,
      abi: rolesAbi,
      functionName: "execTransactionWithRole",
      args: [action.target, 0n, action.data, Operation.Call, roleKey, true],
      account: agent,
    });
    logEvent("preflight", { outcome: "pass", action: action.label });
    return { ok: true };
  } catch (error) {
    const decoded = decodeRevert(error);
    const reason = formatRevert(decoded);
    logEvent("preflight", {
      outcome: "refused",
      action: action.label,
      kind: decoded.kind,
      reason,
      ...(decoded.kind === "roles_condition_violation"
        ? { status: decoded.status, statusName: decoded.statusName, info: decoded.info }
        : {}),
    });
    return { ok: false, decoded, reason };
  }
}

/** True when the refusal has no name — the outcome G2 may never report (PRD.md G2-2). */
export function refusalIsOpaque(result: Preflight): boolean {
  return !result.ok && isUndecodable(result.decoded);
}

export function encodeRoleCall(roleKey: Hex, action: RoleAction): Hex {
  return encodeFunctionData({
    abi: rolesAbi,
    functionName: "execTransactionWithRole",
    args: [action.target, 0n, action.data, Operation.Call, roleKey, true],
  });
}

export async function executeThroughRole(
  network: Network,
  rolesModifier: Address,
  roleKey: Hex,
  agent: Sender,
  action: RoleAction,
  options: { readonly expectRevert?: boolean } = {},
): Promise<SendResult> {
  return sendTx(
    network,
    agent,
    { to: rolesModifier, data: encodeRoleCall(roleKey, action) },
    options.expectRevert === true ? "exec.role.forced" : "exec.role",
    // Gas estimation runs the call first and would throw before the chain ever saw it.
    // A refusal we never sent is not evidence of anything.
    options.expectRevert === true ? { gas: 500_000n, allowRevert: true } : {},
  );
}
