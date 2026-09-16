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
import {
  type Address,
  BaseError,
  encodeFunctionData,
  type Hex,
  HttpRequestError,
  SocketClosedError,
  TimeoutError,
  WebSocketRequestError,
} from "viem";
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
  | {
      readonly ok: false;
      /**
       * True when nobody answered.
       *
       * "The Roles Modifier refused" and "the node did not reply" are different facts and
       * only one of them is a gate reading. They used to arrive here as the same value:
       * a `fetch failed` carries no revert data, `decodeRevert` therefore answered
       * `undecodable`, and G2 reported a refusal — `undecodable revert 0x` — for a
       * question it had never managed to ask. An operator was then sent to check an ABI
       * over an RPC blip, `kill` read an unreachable chain as an agent that could still
       * act, and a receipt could claim a G2 outcome nobody had observed.
       *
       * A gate that refuses because nobody answered is the mirror of a gate that passes
       * because nobody checked, and this codebase already refuses to have the second one.
       */
      readonly unreachable: boolean;
      readonly decoded: DecodedRevert;
      readonly reason: string;
    };

/**
 * Did the chain answer at all?
 *
 * Transport failures are viem error classes, so this asks the type rather than reading
 * the text of a message — which would make the gate's answer depend on how a provider
 * chose to phrase an outage. `RpcRequestError` is deliberately absent: a JSON-RPC error
 * response *is* an answer, just not one we can decode.
 *
 * An error that is not a viem error and carries no revert data anywhere is also counted
 * as unreachable: something threw before the chain was ever asked, and the alternative is
 * reporting a refusal the chain never made.
 */
function chainDidNotAnswer(error: unknown, decoded: DecodedRevert): boolean {
  if (error instanceof BaseError) {
    return (
      error.walk(
        (cause) =>
          cause instanceof HttpRequestError ||
          cause instanceof TimeoutError ||
          cause instanceof WebSocketRequestError ||
          cause instanceof SocketClosedError,
      ) !== null
    );
  }
  return decoded.kind === "undecodable" && decoded.data === "0x";
}

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
    const unreachable = chainDidNotAnswer(error, decoded);
    const reason = unreachable
      ? `the chain did not answer (${firstLine(error)}) — this is not a reading of the ` +
        "preset, and nothing was asked of it"
      : formatRevert(decoded);

    logEvent("preflight", {
      outcome: unreachable ? "unreachable" : "refused",
      action: action.label,
      kind: unreachable ? "rpc_unreachable" : decoded.kind,
      reason,
      ...(decoded.kind === "roles_condition_violation"
        ? { status: decoded.status, statusName: decoded.statusName, info: decoded.info }
        : {}),
    });
    return { ok: false, unreachable, decoded, reason };
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "no detail";
}

/**
 * True when the chain refused and the refusal has no name — the outcome G2 may never
 * report (PRD.md G2-2).
 *
 * Not true of an unreachable chain. That is a different failure with a different fix, and
 * telling an operator their ABI has drifted when their RPC is down costs them the hour
 * they spend believing it.
 */
export function refusalIsOpaque(result: Preflight): boolean {
  return !result.ok && !result.unreachable && isUndecodable(result.decoded);
}

/** True when G2 was never actually asked. Never a reading, never a refusal. */
export function preflightWasUnanswered(result: Preflight): boolean {
  return !result.ok && result.unreachable;
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
  options: {
    readonly expectRevert?: boolean;
    /**
     * Hand a revert back rather than exiting on it.
     *
     * The gated pipeline needs this: a call that reverts on chain is a G4 refusal, and a
     * G4 refusal has a receipt. Exiting inside the send would kill the process between
     * the revert and the record, which is precisely the outcome the receipt chain exists
     * to make impossible — the attempt happened, cost gas, and left no trace.
     */
    readonly allowRevert?: boolean;
  } = {},
): Promise<SendResult> {
  const forced = options.expectRevert === true;
  return sendTx(
    network,
    agent,
    { to: rolesModifier, data: encodeRoleCall(roleKey, action) },
    forced ? "exec.role.forced" : "exec.role",
    // Gas estimation runs the call first and would throw before the chain ever saw it.
    // A refusal we never sent is not evidence of anything.
    forced
      ? { gas: 500_000n, allowRevert: true }
      : options.allowRevert === true
        ? { allowRevert: true }
        : {},
  );
}
