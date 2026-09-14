/**
 * One intent, through the gates, with a receipt whatever happened.
 *
 * Both the everyday `propose` and the deliberately awkward mainnet path run this. They
 * differ in what they print and what they demand before starting — not in how the gates
 * are ordered or when a record is written. A mainnet path with its own copy of the gate
 * logic is a mainnet path that drifts from the one everybody rehearses on.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  appendReceipt,
  checkEnvelope,
  EXPLORER,
  enqueueReview,
  formatEnvelopeError,
  type GateOutcome,
  type Intent,
  type Limits,
  type Receipt,
  type Remit,
  type ReviewDecision,
  readChain,
  readDecision,
} from "@remit/core";
import type { Address, Hex } from "viem";
import { simulateBalanceDelta } from "./balance-delta.js";
import { explorerTx, type Sender } from "./clients.js";
import {
  encodeRoleCall,
  executeThroughRole,
  preflight,
  refusalIsOpaque,
} from "./exec-role.js";
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
  /**
   * Where the G3 queue lives. When set, an action above the Remit's review threshold
   * stops and waits for a human instead of proceeding. Absent, G3 is skipped and the
   * receipt says so — an operator reading "G3: skipped" knows nobody looked, which is
   * more use than a gate that silently passes everything.
   */
  readonly reviewDir?: string;
  /** How long to wait for a decision before giving up. */
  readonly reviewTimeoutSeconds?: number;
};

export type PipelineResult =
  | { readonly stage: "g1"; readonly ok: false; readonly receipt: Receipt }
  | { readonly stage: "g2"; readonly ok: false; readonly receipt: Receipt }
  | { readonly stage: "g3"; readonly ok: false; readonly receipt: Receipt }
  | {
      readonly stage: "g4";
      readonly ok: boolean;
      readonly receipt: Receipt;
      readonly txHash: Hex;
    };

/**
 * Wait for a human, and treat silence as a refusal.
 *
 * A review that times out into an approval is not a review. The poll is a filesystem
 * read every second: the console writes the decision as a file, so nothing needs a
 * socket, a queue or a running server between the two halves.
 */
async function waitForDecision(
  dir: string,
  id: string,
  timeoutSeconds: number,
): Promise<ReviewDecision | undefined> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const answer = readDecision(dir, id);
    if (answer !== undefined) return answer;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return undefined;
}

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
  /**
   * The strategy version this agent last actually executed under, read from the chain of
   * receipts rather than from a variable. If it differs from the one the Remit binds, the
   * strategy has changed since anybody watched it act, and G1 holds the next action for
   * review whatever its size (G3-5).
   */
  // `allowMissing`: the first proposal against a fresh chain has no receipts, and that is
  // the genesis case rather than an error.
  const lastExecuted = [
    ...readChain(dir, { allowMissing: true }).map((entry) => entry.receipt as Receipt),
  ]
    .reverse()
    .find((receipt) => receipt.outcome === "executed");

  const envelope = checkEnvelope({
    remit,
    limits,
    chainId: network.chainId,
    intent: input.intent,
    now,
    ledger: readLedger(network.name),
    ...(lastExecuted === undefined
      ? {}
      : { seenStrategyHash: lastExecuted.strategyHash }),
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

  // ---- G3 ------------------------------------------------------------------
  const g3: GateOutcome[] = [];
  if (decision.requiresReview && input.reviewDir !== undefined) {
    const id = randomUUID();
    // Simulated before the item is queued, so the reviewer sees it on first render
    // rather than waiting for it.
    const delta = await simulateBalanceDelta(
      network,
      agent.address,
      remit.safe,
      rolesModifier,
      encodeRoleCall(remit.roleKey, action),
    );
    enqueueReview(input.reviewDir, {
      id,
      at: now,
      network: network.name,
      remitHash: input.remitHash,
      intent: decision.intent,
      action: receiptAction,
      gates: [
        { gate: "G1", outcome: "pass", detail: decision.action.description },
        { gate: "G2", outcome: "pass", detail: "preflight clean, no gas spent" },
      ],
      headroomUsd: (Number(decision.headroomMicros) / 1e6).toFixed(2),
      reason:
        decision.reviewReason ??
        `above the Remit's review threshold of ${limits.requireReviewAboveUsd} USD`,
      ...(delta.available
        ? { balanceDelta: { usdc: delta.usdc, note: delta.note } }
        : {}),
    });

    say(`G3 WAITING  ${id} — a human has to approve this in the console`);
    say(`            ${decision.reviewReason ?? "above the review threshold"}`);
    say(
      `            safe USDC ${delta.available ? `${delta.usdc} (${delta.note})` : delta.note}`,
    );
    logEvent("gate.g3", { outcome: "waiting", id, usd: decision.usd });

    const answer = await waitForDecision(
      input.reviewDir,
      id,
      input.reviewTimeoutSeconds ?? 600,
    );

    if (answer === undefined) {
      say("G3 TIMEOUT  nobody answered — treating silence as a refusal");
      const receipt = write({
        intent: decision.intent,
        action: receiptAction,
        gates: [
          { gate: "G1", outcome: "pass" },
          { gate: "G2", outcome: "pass" },
          { gate: "G3", outcome: "declined", code: "G3_TIMEOUT", detail: id },
        ],
        outcome: "declined_g3",
        submission: noSubmission,
      });
      return { stage: "g3", ok: false, receipt };
    }

    if (answer.decision === "declined") {
      say(
        `G3 DECLINED ${answer.by}${answer.note === undefined ? "" : `: ${answer.note}`}`,
      );
      logEvent("gate.g3", { outcome: "declined", id, by: answer.by });
      const receipt = write({
        intent: decision.intent,
        action: receiptAction,
        gates: [
          { gate: "G1", outcome: "pass" },
          { gate: "G2", outcome: "pass" },
          {
            gate: "G3",
            outcome: "declined",
            code: "G3_DECLINED",
            detail: `${answer.by}${answer.note === undefined ? "" : `: ${answer.note}`}`,
          },
        ],
        outcome: "declined_g3",
        submission: noSubmission,
      });
      return { stage: "g3", ok: false, receipt };
    }

    say(`G3 APPROVED ${answer.by}`);
    logEvent("gate.g3", { outcome: "approved", id, by: answer.by });
    g3.push({ gate: "G3", outcome: "pass", detail: `approved by ${answer.by}` });
  } else if (decision.requiresReview) {
    g3.push({
      gate: "G3",
      outcome: "skipped",
      detail: "no review queue configured — nobody looked at this",
    });
  }

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
      ...g3,
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
