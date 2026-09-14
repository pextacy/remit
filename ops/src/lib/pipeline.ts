/**
 * One intent, through the gates, with a receipt whatever happened.
 *
 * Both the everyday `propose` and the deliberately awkward mainnet path run this. They
 * differ in what they print and what they demand before starting — not in how the gates
 * are ordered or when a record is written. A mainnet path with its own copy of the gate
 * logic is a mainnet path that drifts from the one everybody rehearses on.
 */
import { join } from "node:path";
import {
  appendReceipt,
  checkEnvelope,
  EXPLORER,
  formatEnvelopeError,
  type GateOutcome,
  type Intent,
  type Limits,
  type Receipt,
  type Remit,
} from "@remit/core";
import type { Address, Hex } from "viem";
import { explorerTx, type Sender } from "./clients.js";
import { executeThroughRole, preflight, refusalIsOpaque } from "./exec-role.js";
import { appendLedger, readLedger } from "./ledger-store.js";
import { fail, logEvent, say } from "./log.js";
import type { Network } from "./networks.js";

export type PipelineInput = {
  readonly network: Network;
  readonly remit: Remit;
  readonly remitHash: Hex;
  readonly limits: Limits;
  readonly rolesModifier: Address;
  readonly agent: Sender;
  readonly intent: unknown;
  readonly receiptsRoot: string;
};

export type PipelineResult =
  | { readonly stage: "g1"; readonly ok: false; readonly receipt: Receipt }
  | { readonly stage: "g2"; readonly ok: false; readonly receipt: Receipt }
  | {
      readonly stage: "g4";
      readonly ok: boolean;
      readonly receipt: Receipt;
      readonly txHash: Hex;
    };

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { network, remit, limits, rolesModifier, agent } = input;
  const now = Math.floor(Date.now() / 1000);
  const dir = join(input.receiptsRoot, network.name);

  const write = (
    body: Pick<Receipt, "intent" | "action" | "gates" | "outcome" | "submission">,
  ): Receipt => {
    const { receipt, file } = appendReceipt(dir, {
      version: 1,
      at: now,
      network: network.name,
      chainId: network.chainId,
      remitHash: input.remitHash,
      strategyHash: remit.strategyHash,
      workflowHash: remit.workflowHash,
      limitsHash: remit.limitsHash,
      roleKey: remit.roleKey,
      safe: remit.safe,
      rolesModifier,
      agent: agent.address,
      ...body,
    });
    say(`receipt     ${file}  ${receipt.selfHash}`);
    logEvent("receipt.written", {
      file,
      selfHash: receipt.selfHash,
      sequence: receipt.sequence,
      outcome: receipt.outcome,
    });
    return receipt;
  };

  const noSubmission = {
    path: "none",
    executionId: null,
    workflowId: null,
    txHash: null,
    explorer: null,
    gasUsed: null,
  } as const;

  // ---- G1 ------------------------------------------------------------------
  const envelope = checkEnvelope({
    remit,
    limits,
    chainId: network.chainId,
    intent: input.intent,
    now,
    ledger: readLedger(network.name),
  });

  if (!envelope.ok) {
    say(`G1 REFUSED  ${formatEnvelopeError(envelope.error)}`);
    logEvent("gate.g1", { outcome: "refused", ...envelope.error });
    const receipt = write({
      intent: input.intent as Intent,
      // Null, not filler: the intent never reached the compiler.
      action: null,
      gates: [
        {
          gate: "G1",
          outcome: "refused",
          code: envelope.error.code,
          detail: formatEnvelopeError(envelope.error),
        },
      ],
      outcome: "rejected_g1",
      submission: noSubmission,
    });
    return { stage: "g1", ok: false, receipt };
  }

  const { decision } = envelope;
  const action = {
    label: decision.action.description,
    target: decision.action.target,
    data: decision.action.calldata,
  };
  const receiptAction = {
    target: decision.action.target,
    signature: decision.action.signature,
    selector: decision.action.selector,
    description: decision.action.description,
    usd: decision.usd,
  };

  say(`G1 PASS     ${decision.action.description}`);
  say(
    `            ${decision.usd} USD, headroom ${Number(decision.headroomMicros) / 1e6} USD today`,
  );
  if (decision.requiresReview) {
    say(
      `            above ${limits.requireReviewAboveUsd} USD — G3 would hold this (P9)`,
    );
  }
  logEvent("gate.g1", {
    outcome: "pass",
    action: decision.action.description,
    usd: decision.usd,
    requiresReview: decision.requiresReview,
  });

  // ---- G2 ------------------------------------------------------------------
  const check = await preflight(
    network,
    rolesModifier,
    remit.roleKey,
    agent.address,
    action,
  );

  if (!check.ok) {
    say(`G2 REFUSED  ${check.reason}`);
    if (refusalIsOpaque(check)) {
      fail(
        "preflight returned an undecodable revert — the ABI no longer matches the chain",
      );
    }
    logEvent("gate.g2", { outcome: "refused", reason: check.reason });
    const receipt = write({
      intent: decision.intent,
      action: receiptAction,
      gates: [
        { gate: "G1", outcome: "pass", detail: decision.action.description },
        {
          gate: "G2",
          outcome: "refused",
          code:
            check.decoded.kind === "roles_condition_violation"
              ? check.decoded.statusName
              : check.decoded.kind,
          detail: check.reason,
        },
      ],
      outcome: "rejected_g2",
      submission: noSubmission,
    });
    return { stage: "g2", ok: false, receipt };
  }
  say("G2 PASS     the Roles Modifier would allow this call");

  // ---- G4 ------------------------------------------------------------------
  const result = await executeThroughRole(
    network,
    rolesModifier,
    remit.roleKey,
    agent,
    action,
  );

  // Written only once value actually moved: a cap consumed by a call that spent nothing
  // would tighten every time the chain said no.
  appendLedger(network.name, decision.entry);

  const g4: GateOutcome =
    result.status === "success"
      ? { gate: "G4", outcome: "pass", detail: result.hash }
      : { gate: "G4", outcome: "reverted", detail: result.hash };

  say(`G4 ${result.status === "success" ? "PASS" : "REVERTED"}     ${result.hash}`);
  say(`            ${explorerTx(network.chainId, result.hash)}`);
  logEvent("gate.g4", {
    outcome: result.status,
    txHash: result.hash,
    gasUsed: result.gasUsed.toString(),
  });

  const receipt = write({
    intent: decision.intent,
    action: receiptAction,
    gates: [
      { gate: "G1", outcome: "pass", detail: decision.action.description },
      { gate: "G2", outcome: "pass", detail: "preflight clean, no gas spent" },
      g4,
    ],
    outcome: result.status === "success" ? "executed" : "reverted_g4",
    submission: {
      // The operator's hand-run path, named so that no receipt implies KeeperHub
      // executed something it never saw. The product path is the bridge's.
      path: "ops-direct",
      executionId: null,
      workflowId: null,
      txHash: result.hash,
      explorer: `${EXPLORER[network.chainId]}/tx/${result.hash}`,
      gasUsed: result.gasUsed.toString(),
    },
  });

  return { stage: "g4", ok: result.status === "success", receipt, txHash: result.hash };
}
