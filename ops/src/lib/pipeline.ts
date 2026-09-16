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
  intentSchema,
  type Limits,
  microsToUsd,
  type Receipt,
  type Remit,
  type ReviewDecision,
  readChain,
  readDecision,
  receiptSchema,
  unparseableIntent,
  withLockAsync,
} from "@remit/core";
import type { Address, Hex } from "viem";
import { simulateBalanceDelta } from "./balance-delta.js";
import { explorerTx, type Sender } from "./clients.js";
import {
  encodeRoleCall,
  executeThroughRole,
  preflight,
  preflightWasUnanswered,
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
   * Where the G3 queue lives. An action above the Remit's review threshold stops here and
   * waits for a human.
   */
  readonly reviewDir?: string;
  /**
   * What to do when review is required and no queue is configured.
   *
   * `"refuse"` — the default, and the only safe one. G3 used to be skipped in this case
   * and the action went to the chain anyway, so the gate the README calls deliberately
   * redundant could be removed by *omitting a flag*. A gate that is absent unless asked
   * for is not a gate.
   *
   * `"proceed"` exists because an operator running a rehearsal with nobody watching is a
   * real thing, and taking the escape hatch away means they find a worse one. It has to
   * be asked for, and the receipt records that nobody looked.
   */
  readonly whenUnreviewable?: "refuse" | "proceed";
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

/**
 * One proposal at a time, per network.
 *
 * G1's two history rules — the rolling daily cap and the rate limit — are read-modify-write
 * over a ledger that is only written once the chain has answered. Between those two moments
 * sits a preflight, possibly a human, and a transaction. Two proposals running at once each
 * read a day in which the other has spent nothing, each pass a cap of 25 USD with 20 USD
 * already committed, and the operator's daily cap turns out to be per-process.
 *
 * So the whole pipeline is the critical section, not just the append. The lock is a file
 * the Python bridge takes too, so the gate counts one history however the action arrived.
 * Waiting is bounded and failure is a refusal: a cap counted against a history somebody
 * else is still changing is not a cap.
 */
function lockPathFor(input: PipelineInput): string {
  return join(input.receiptsRoot, input.network.name, ".pipeline.lock");
}

/**
 * How long to wait for a person, with a value that cannot become "not at all".
 *
 * A `NaN` here is not a long wait: every `Date.now() < deadline` against it is false, so
 * the review deadline has already passed the moment it is set and G3 refuses before
 * anybody could look. The scripts refuse a malformed `--review-timeout` where it was
 * typed; this is the same rule for every other caller, because a human gate that a bad
 * number can remove is not a gate.
 */
export function reviewTimeoutOf(input: PipelineInput): number {
  const asked = input.reviewTimeoutSeconds;
  if (asked === undefined) return 600;
  if (!Number.isFinite(asked) || asked <= 0) {
    fail(
      `reviewTimeoutSeconds must be a positive number of seconds, not ${String(asked)}` +
        " — refusing rather than treating it as no wait at all",
    );
  }
  return asked;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  // A review can legitimately hold the lock for as long as a person takes to answer, so
  // the wait allows for one — plus the margin a chain transaction needs behind it.
  const waitMs = (reviewTimeoutOf(input) + 120) * 1000;
  // `staleMs` is left at its default. The holder heartbeats while it works, so the window
  // is "how long since it last said it was alive" rather than "how long it has held" —
  // which is what lets a ten-minute review hold the lock while a killed process is
  // displaced within a minute.
  return withLockAsync(lockPathFor(input), () => runPipelineLocked(input), {
    timeoutMs: waitMs,
    onWait: (holder) => {
      // Silence for as long as a person takes to answer a review is indistinguishable
      // from a hang, and the operator's next move is to kill the command.
      say(`WAITING     another proposal on ${input.network.name} holds the gates`);
      say(`            ${holder} — probably at G3, waiting for somebody to answer`);
      logEvent("pipeline.waiting", { network: input.network.name, holder });
    },
  });
}

async function runPipelineLocked(input: PipelineInput): Promise<PipelineResult> {
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
  // Parsed, not cast. `readChain` hands back a record for every file it found, including
  // ones it could not read — `receipt: undefined` — and a cast walked straight into
  // reading `.outcome` off one of them. A chain with a truncated file would then take the
  // process down at G1, before the gate that exists to refuse cheaply had run.
  const lastExecuted = [...readChain(dir, { allowMissing: true })]
    .reverse()
    .map((entry) => receiptSchema.safeParse(entry.receipt))
    .find((parsed) => parsed.success && parsed.data.outcome === "executed");
  const seenStrategyHash =
    lastExecuted?.success === true ? lastExecuted.data.strategyHash : undefined;

  const envelope = checkEnvelope({
    remit,
    limits,
    chainId: network.chainId,
    intent: input.intent,
    now,
    ledger: readLedger(network.name),
    ...(seenStrategyHash === undefined ? {} : { seenStrategyHash }),
  });

  if (!envelope.ok) {
    say(`G1 REFUSED  ${formatEnvelopeError(envelope.error)}`);
    logEvent("gate.g1", { outcome: "refused", ...envelope.error });
    // What was proposed, recorded as what it was. An intent that failed the schema is
    // not an intent, and casting it into the receipt's `intent` field used to throw
    // inside the seal — so the one refusal most worth recording produced no record and
    // took the process with it.
    const proposed = intentSchema.safeParse(input.intent);
    const receipt = write({
      intent: proposed.success ? proposed.data : unparseableIntent(input.intent),
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
    `            ${decision.usd} USD, headroom ${microsToUsd(decision.headroomMicros)} USD today`,
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

  // ---- can this action be reviewed at all? ---------------------------------
  //
  // Taken here, before G2, because it is a fact about the configuration rather than about
  // the action: there is nobody to ask, and there was never going to be. G1's whole value
  // is refusing before any I/O, and an operator who forgot to point at a queue should
  // find that out for the same price rather than after an eth_call.
  //
  // It used to be neither — review was skipped and the action went to the chain, so the
  // gate the README calls deliberately redundant could be removed by omitting a flag.
  if (
    decision.requiresReview &&
    input.reviewDir === undefined &&
    (input.whenUnreviewable ?? "refuse") === "refuse"
  ) {
    say("G3 REFUSED  this action needs a person and there is no review queue");
    logEvent("gate.g3", { outcome: "refused", code: "G3_NO_REVIEWER" });
    const receipt = write({
      intent: decision.intent,
      action: receiptAction,
      gates: [
        { gate: "G1", outcome: "pass", detail: decision.action.description },
        {
          gate: "G2",
          outcome: "skipped",
          detail: "not asked — the action stops before it, for free",
        },
        {
          gate: "G3",
          outcome: "declined",
          code: "G3_NO_REVIEWER",
          detail:
            `${decision.reviewReason ?? "above the review threshold"} — no review queue ` +
            "was configured, so nobody could look. Refused rather than passed.",
        },
      ],
      outcome: "declined_g3",
      submission: noSubmission,
    });
    return { stage: "g3", ok: false, receipt };
  }

  // ---- G2 ------------------------------------------------------------------
  const check = await preflight(
    network,
    rolesModifier,
    remit.roleKey,
    agent.address,
    action,
  );

  if (!check.ok) {
    /**
     * The record comes first, whatever kind of "no" this is.
     *
     * It used to be the other way round for an opaque revert: `fail()` exits the process,
     * and it was called *above* the write — so the one G2 outcome most worth having a
     * record of left none. That is the same mistake `allowRevert` exists to prevent at
     * G4, and it was reachable here by an RPC blip, because an unreachable chain decoded
     * as `undecodable` too.
     *
     * An unanswered preflight is written as `skipped` rather than `refused`. Nothing was
     * asked of the modifier, so claiming it said no would be the audit trail asserting a
     * gate reading nobody took — and the receipt still exists, saying exactly that.
     */
    const unanswered = preflightWasUnanswered(check);
    say(`G2 ${unanswered ? "UNKNOWN " : "REFUSED "} ${check.reason}`);
    logEvent("gate.g2", {
      outcome: unanswered ? "unreachable" : "refused",
      reason: check.reason,
    });

    const receipt = write({
      intent: decision.intent,
      action: receiptAction,
      gates: [
        { gate: "G1", outcome: "pass", detail: decision.action.description },
        unanswered
          ? {
              gate: "G2",
              outcome: "skipped",
              code: "RPC_UNREACHABLE",
              detail: check.reason,
            }
          : {
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

    if (unanswered) {
      say("            nothing was sent. The gate was not asked, so it did not pass.");
    } else if (refusalIsOpaque(check)) {
      // Now that the record is on disk, this can end the run as loudly as it likes. A
      // refusal G2 cannot name means the deployed modifier is not the version whose ABI
      // this build pins, which is a thing to stop for (PRD.md G2-2).
      fail(
        "preflight returned an undecodable revert — the ABI no longer matches the chain",
      );
    }

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
      // Exact, from the integer micro-dollars the gate computed. It was
      // `(Number(…) / 1e6).toFixed(2)`, which is both a float and a *rounding*: a
      // reviewer was shown a headroom figure that was not the headroom, on the one
      // screen whose whole job is to be checked rather than trusted, and it rounded
      // upwards as readily as down.
      headroomUsd: microsToUsd(decision.headroomMicros),
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

    const answer = await waitForDecision(input.reviewDir, id, reviewTimeoutOf(input));

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

    /**
     * G1 again, at the time the action would actually happen.
     *
     * A review takes as long as a person takes, and the first pass through G1 answered
     * about `now` as it was before anybody looked. A Remit that expires during the review
     * — or a rate window that has moved — would otherwise be authority the operator had
     * already withdrawn, spent because somebody clicked approve just after it lapsed.
     *
     * It is a pure function over the same inputs, so this costs nothing and can only
     * narrow: the ledger cannot have changed, because this run has held the lock since
     * before G1.
     */
    const still = checkEnvelope({
      remit,
      limits,
      chainId: network.chainId,
      intent: decision.intent,
      now: Math.floor(Date.now() / 1000),
      ledger: readLedger(network.name),
      ...(seenStrategyHash === undefined ? {} : { seenStrategyHash }),
    });

    if (!still.ok) {
      say(`G1 REFUSED  ${formatEnvelopeError(still.error)} — after the review`);
      logEvent("gate.g1", { outcome: "refused", when: "after-review", ...still.error });
      const receipt = write({
        intent: decision.intent,
        action: receiptAction,
        gates: [
          { gate: "G1", outcome: "pass", detail: decision.action.description },
          { gate: "G2", outcome: "pass", detail: "preflight clean, no gas spent" },
          { gate: "G3", outcome: "pass", detail: `approved by ${answer.by}` },
          {
            gate: "G1",
            outcome: "refused",
            code: still.error.code,
            detail:
              `${formatEnvelopeError(still.error)} — the envelope was re-checked after ` +
              "the review and no longer holds",
          },
        ],
        outcome: "rejected_g1",
        submission: noSubmission,
      });
      return { stage: "g1", ok: false, receipt };
    }

    g3.push({ gate: "G3", outcome: "pass", detail: `approved by ${answer.by}` });
  } else if (decision.requiresReview) {
    // Reached only with `whenUnreviewable: "proceed"` — the refusal is taken before G2,
    // where it costs nothing.
    say("G3 SKIPPED  nobody is watching, and the caller said to proceed anyway");
    g3.push({
      gate: "G3",
      outcome: "skipped",
      detail:
        `${decision.reviewReason ?? "above the review threshold"} — the caller asked ` +
        "to proceed with no reviewer. Nobody looked at this.",
    });
  }

  // ---- G4 ------------------------------------------------------------------
  // `allowRevert`: a reverted transaction is a G4 refusal and gets a receipt like every
  // other refusal. Exiting inside the send instead — which is what happens without this
  // — would end the process between the revert and the record, and an attempt that cost
  // gas and left no trace is the one outcome the chain of receipts exists to prevent.
  const result = await executeThroughRole(
    network,
    rolesModifier,
    remit.roleKey,
    agent,
    action,
    { allowRevert: true },
  );

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

  // The ledger is written *after* the receipt, and never in a way that can destroy it.
  //
  // A transaction that succeeded has already moved value, and the record of it is the one
  // thing that must exist. `appendLedger` can legitimately throw — an unreadable ledger
  // is a hard failure by design — and doing it first meant an executed transaction could
  // take the process down before its receipt was sealed, leaving gas spent and no trace:
  // exactly the outcome the chain of receipts exists to prevent.
  //
  // Only a success consumes the cap: a call the chain refused spent nothing, and charging
  // it would tighten the remit every time the chain said no.
  if (result.status === "success") {
    try {
      appendLedger(network.name, decision.entry);
    } catch (error) {
      // Loud, and not fatal. The receipt is on disk; the cap is the thing now in doubt,
      // and an operator has to know that before the next action rather than after it.
      say("LEDGER      the spend could not be recorded — the daily cap is now wrong");
      logEvent("ledger.append.failed", {
        message: error instanceof Error ? error.message : String(error),
        receipt: receipt.selfHash,
        txHash: result.hash,
      });
      throw error;
    }
  }

  return { stage: "g4", ok: result.status === "success", receipt, txHash: result.hash };
}
