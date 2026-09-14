/**
 * An intent, through the gates, to the chain.
 *
 *   pnpm --filter ops propose --network anvil --kind supply   --amount 5
 *   pnpm --filter ops propose --network anvil --kind withdraw --amount 2 --to 0x…
 *
 * The first two gates, in order, over the issued Remit:
 *
 *   G1  the envelope — pure, free, and before any I/O. A refusal here costs one function
 *       call and tells the operator which field of which document was violated.
 *   G2  the preflight — one `eth_call`, no gas. A refusal here is a named Status from the
 *       Roles Modifier.
 *   G4  the chain. Only reached if both agreed.
 *
 * G3 is the human review, and lands with the console in P9; an action above the Remit's
 * review threshold says so here and proceeds, which is the one thing this script does
 * that the finished bridge will not.
 *
 * In P3 the last step stops being a direct send and becomes a KeeperHub workflow
 * invocation. The two gates in front of it do not change, which is the point of keeping
 * them here rather than in the script that happens to send.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendReceipt,
  checkEnvelope,
  EXPLORER,
  formatEnvelopeError,
  type GateOutcome,
  type Intent,
  limitsSchema,
  type ReceiptBody,
  remitDigest,
  remitSchema,
  USDC_DECIMALS,
} from "@remit/core";
import { getAddress, parseUnits } from "viem";
import { AAVE_POOL_FOR } from "../lib/actions.js";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { explorerTx } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { executeThroughRole, preflight, refusalIsOpaque } from "../lib/exec-role.js";
import { appendLedger, readLedger } from "../lib/ledger-store.js";
import { fail, logEvent, say } from "../lib/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const RECEIPTS = join(REPO, "receipts");

const args = parseArgs();
const network = networkFrom(args);
const deployment = requireDeployment(network.name);
const rolesModifier = requireField(deployment, "rolesModifier");

let file: { remit: unknown; limits: unknown };
try {
  file = JSON.parse(
    readFileSync(join(REPO, "ops", "remits", `${network.name}.json`), "utf8"),
  ) as typeof file;
} catch {
  fail(`no Remit at ops/remits/${network.name}.json — run remit:issue first`);
}

const remit = remitSchema.parse(file.remit);
const limits = limitsSchema.parse(file.limits);
const remitHashOf =
  (file as { remitHash?: `0x${string}` }).remitHash ?? remitDigest(remit);
const cast = await castFor(network);

const amount = parseUnits(option(args, "amount") ?? "1", USDC_DECIMALS).toString();
const kind = option(args, "kind") ?? "supply";
const counterpartyArg = option(args, "to") ?? option(args, "spender");

/**
 * The sensible default differs by kind, and getting it wrong is instructive: value goes
 * to the Safe, but an approval goes to the venue. They are different questions with
 * different allowlists, which is exactly why G1 checks them separately.
 */
const counterparty =
  counterpartyArg === undefined
    ? kind === "approve"
      ? AAVE_POOL_FOR(network.chainId)
      : remit.safe
    : getAddress(counterpartyArg);

/**
 * The intent is assembled from typed arguments here, exactly as the Almanak adapter will
 * assemble it from a strategy action in P5. Nothing on this path can produce bytes.
 */
function buildIntent(): unknown {
  switch (kind) {
    case "approve":
      return { kind, asset: "USDC", amount, spender: counterparty };
    case "supply":
      return { kind, asset: "USDC", amount, onBehalfOf: counterparty };
    case "withdraw":
      return { kind, asset: "USDC", amount, to: counterparty };
    default:
      return fail("--kind must be approve, supply or withdraw");
  }
}

const intent = buildIntent();
const now = Math.floor(Date.now() / 1000);
const ledger = readLedger(network.name);

/**
 * Every attempt leaves a record, whichever gate decided (PRD.md RC-1).
 *
 * `path: "ops-direct"` is the truth about this script: the agent signer calls the
 * Roles Modifier itself, because KeeperHub needs an account nobody has yet (OQ-1).
 * Recording it under its own name is what stops a receipt from implying KeeperHub
 * executed something it never saw. When the bridge takes over, the path changes and
 * the rest of the record does not.
 */
function writeReceipt(
  body: Pick<ReceiptBody, "intent" | "action" | "gates" | "outcome" | "submission">,
): void {
  const { receipt, file } = appendReceipt(join(RECEIPTS, network.name), {
    version: 1,
    at: now,
    network: network.name,
    chainId: network.chainId,
    remitHash: remitHashOf,
    strategyHash: remit.strategyHash,
    workflowHash: remit.workflowHash,
    limitsHash: remit.limitsHash,
    roleKey: remit.roleKey,
    safe: remit.safe,
    rolesModifier: remit.rolesModifier,
    agent: cast.agent.address,
    ...body,
  });
  say(`receipt     ${file}  ${receipt.selfHash}`);
  logEvent("receipt.written", {
    file,
    selfHash: receipt.selfHash,
    sequence: receipt.sequence,
    outcome: receipt.outcome,
  });
}

say(
  `remit     ${remit.limitsHash.slice(0, 10)}… caps ${limits.perTxCapUsd}/${limits.dailyCapUsd} USD`,
);
say(`intent    ${JSON.stringify(intent)}`);
say("");

// ---- G1 --------------------------------------------------------------------
const envelope = checkEnvelope({
  remit,
  limits,
  chainId: network.chainId,
  intent,
  now,
  ledger,
});

if (!envelope.ok) {
  say(`G1 REFUSED  ${formatEnvelopeError(envelope.error)}`);
  writeReceipt({
    intent: intent as Intent,
    // Null, not filler: the intent never reached the compiler, so no call was built.
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
    submission: {
      path: "none",
      executionId: null,
      workflowId: null,
      txHash: null,
      explorer: null,
      gasUsed: null,
    },
  });
  say("");
  say("No network call was made. The refusal cost one function call and no gas.");
  logEvent("gate.g1", { outcome: "refused", ...envelope.error });
  process.exit(2);
}

const { decision } = envelope;
say(`G1 PASS     ${decision.action.description}`);
say(
  `            ${decision.usd} USD, headroom ${Number(decision.headroomMicros) / 1e6} USD today`,
);
if (decision.requiresReview) {
  say(
    `            above ${limits.requireReviewAboveUsd} USD — G3 would hold this for a human (P9)`,
  );
}
logEvent("gate.g1", {
  outcome: "pass",
  action: decision.action.description,
  usd: decision.usd,
  requiresReview: decision.requiresReview,
});

// ---- G2 --------------------------------------------------------------------
const action = {
  label: decision.action.description,
  target: decision.action.target,
  data: decision.action.calldata,
};

/** The compiled call as a receipt records it: named parameters, never raw bytes. */
const receiptAction = {
  target: decision.action.target,
  signature: decision.action.signature,
  selector: decision.action.selector,
  description: decision.action.description,
  usd: decision.usd,
};

const check = await preflight(
  network,
  rolesModifier,
  remit.roleKey,
  cast.agent.address,
  action,
);

if (!check.ok) {
  say(`G2 REFUSED  ${check.reason}`);
  if (refusalIsOpaque(check)) {
    fail(
      "preflight returned an undecodable revert — the ABI no longer matches the chain",
    );
  }
  writeReceipt({
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
    submission: {
      path: "none",
      executionId: null,
      workflowId: null,
      txHash: null,
      explorer: null,
      gasUsed: null,
    },
  });
  say("");
  say("One eth_call, no gas. The operator has the reason before anything is spent.");
  logEvent("gate.g2", { outcome: "refused", reason: check.reason });
  process.exit(3);
}
say("G2 PASS     the Roles Modifier would allow this call");

// ---- G4 --------------------------------------------------------------------
const result = await executeThroughRole(
  network,
  rolesModifier,
  remit.roleKey,
  cast.agent,
  action,
);

// The entry is written only once value has actually moved. A cap on spending that is
// consumed by a call which spent nothing would tighten every time the chain said no,
// and an agent would lose its daily allowance to a venue outage.
appendLedger(network.name, decision.entry);

const g4: GateOutcome =
  result.status === "success"
    ? { gate: "G4", outcome: "pass", detail: result.hash }
    : { gate: "G4", outcome: "reverted", detail: result.hash };

say(`G4 ${result.status === "success" ? "PASS" : "REVERTED"}     ${result.hash}`);
say(`            ${explorerTx(network.chainId, result.hash)}`);

writeReceipt({
  intent: decision.intent,
  action: receiptAction,
  gates: [
    { gate: "G1", outcome: "pass", detail: decision.action.description },
    { gate: "G2", outcome: "pass", detail: "preflight clean, no gas spent" },
    g4,
  ],
  outcome: result.status === "success" ? "executed" : "reverted_g4",
  submission: {
    path: "ops-direct",
    executionId: null,
    workflowId: null,
    txHash: result.hash,
    explorer: `${EXPLORER[network.chainId]}/tx/${result.hash}`,
    gasUsed: result.gasUsed.toString(),
  },
});
logEvent("gate.g4", {
  outcome: result.status,
  txHash: result.hash,
  gasUsed: result.gasUsed.toString(),
});
