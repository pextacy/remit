/**
 * The kill switch.
 *
 *   pnpm --filter ops kill --network anvil
 *   pnpm --filter ops kill --network anvil --restore
 *
 * One owner transaction calling `assignRoles(agent, [roleKey], [false])`. It is instant,
 * total, and it consults nothing in this repository — no service of ours has to be
 * reachable, no key of ours has to work, and nobody has to phone us. That property is
 * the whole reason the authority lives in a Safe module rather than in our process.
 *
 * The script proves it took effect rather than asserting it did: after the transaction it
 * re-runs the preflight that G2 runs, and records a receipt for the state before and the
 * state after (PRD.md NH-4). Two receipts, in one chain, showing the transition.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendReceipt,
  compileIntent,
  remitDigest,
  remitSchema,
  USDC_DECIMALS,
} from "@remit/core";
import { parseUnits } from "viem";
import { AAVE_POOL_FOR } from "../lib/actions.js";
import { castFor } from "../lib/actors.js";
import { networkFrom, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { preflight, preflightWasUnanswered } from "../lib/exec-role.js";
import { fail, logEvent, say } from "../lib/log.js";
import { assignRole, isRoleMember } from "../lib/roles.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");
const agent = requireField(deployment, "agentSigner");

const restore = args.flags.has("restore");

let bundle: { remit: unknown; limits: unknown } | undefined;
try {
  bundle = JSON.parse(
    readFileSync(join(REPO, "ops", "remits", `${network.name}.json`), "utf8"),
  ) as typeof bundle;
} catch {
  bundle = undefined;
}

/**
 * The probe: the smallest legitimate action the agent has, simulated.
 *
 * A real intent rather than an empty call, so the answer is the one an operator cares
 * about — *can this agent still move money?* — and it costs no gas either way.
 *
 * `approve` specifically, because it depends on no prior state: a `supply` on an unfunded
 * Safe fails inside Aave, which is a true answer to a different question and makes the
 * before/after reading harder to trust than it should be.
 */
const probeIntent = {
  kind: "approve",
  asset: "USDC",
  amount: parseUnits("1", USDC_DECIMALS).toString(),
  spender: AAVE_POOL_FOR(network.chainId),
} as const;
const probeAction = compileIntent(network.chainId, probeIntent);

/**
 * The probe asks about *authority*, not about whether the call would succeed.
 *
 * Those are different questions and the Roles Modifier answers them with different
 * errors. `NoMembership`, `NotAuthorized` and any `ConditionViolation` mean the role
 * refused. `ModuleTransactionFailed` means the role let the call through and the call
 * itself failed — an empty allowance, an unfunded Safe — which says nothing about the
 * kill switch. Conflating them would make an unfunded Safe look like a revoked agent,
 * and an operator checking the switch would be told what they wanted to hear.
 */
type Probe = {
  allowed: boolean;
  reason: string;
  /** The name the modifier actually gave, when it refused. Never invented. */
  code: string | undefined;
  /**
   * True when the chain never answered.
   *
   * Neither `allowed` nor refused. An unreachable node used to fall through to the
   * `allowed: true` branch below — "the role allowed it; the call itself would fail" —
   * so a blip while checking the switch read as *an agent that can still act*, and the
   * receipt written beside it claimed a `G2 pass` nobody had observed. The switch is the
   * thing an operator reaches for when everything else has broken, which is exactly when
   * an RPC is least likely to answer.
   */
  answered: boolean;
};

async function probe(): Promise<Probe> {
  const result = await preflight(network, rolesModifier, roleKey, agent, {
    label: probeAction.description,
    target: probeAction.target,
    data: probeAction.calldata,
  });

  if (result.ok) {
    return {
      allowed: true,
      reason: "the Roles Modifier would allow it",
      code: undefined,
      answered: true,
    };
  }

  if (preflightWasUnanswered(result)) {
    return {
      allowed: false,
      reason: result.reason,
      code: "RPC_UNREACHABLE",
      answered: false,
    };
  }

  const decoded = result.decoded;
  const refusedByRole =
    decoded.kind === "roles_condition_violation" ||
    (decoded.kind === "roles_error" &&
      (decoded.name === "NoMembership" || decoded.name === "NotAuthorized"));

  // The code that goes in the receipt is the one the chain gave. A revoked agent answers
  // `NotAuthorized` as often as `NoMembership` — the first comes from the `moduleOnly`
  // guard, the second one layer in — and a receipt that always says `NoMembership` is a
  // receipt naming a refusal that may not have happened.
  const code =
    decoded.kind === "roles_condition_violation"
      ? decoded.statusName
      : decoded.kind === "roles_error"
        ? decoded.name
        : decoded.kind;

  return refusedByRole
    ? { allowed: false, reason: result.reason, code, answered: true }
    : {
        allowed: true,
        reason: `the role allowed it; the call itself would fail (${result.reason})`,
        code: undefined,
        answered: true,
      };
}

/**
 * Write the reading down — and never let that stop the switch being pulled.
 *
 * The receipt is evidence of the transition; the transition is the point. A Remit file
 * that is JSON but not a Remit used to throw out of `remitSchema.parse` here, before the
 * revoke transaction was sent, and the process exited — so a corrupt file two directories
 * away disabled the one command whose entire promise is that it "consults nothing in this
 * repository". The same is true of a receipt chain with an unreadable head, or a
 * read-only disk.
 *
 * Every one of those is worth saying out loud and none of them is worth stopping for. An
 * operator at 02:00 needs the agent's authority gone; a missing record of it is a thing
 * to reconcile afterwards.
 */
function record(phase: "before" | "after", result: Probe): void {
  try {
    recordOrThrow(phase, result);
  } catch (error) {
    say(
      `(the ${phase} reading could not be recorded: ` +
        `${error instanceof Error ? error.message : String(error)})`,
    );
    say("  the kill switch does not depend on it — carrying on");
    logEvent("kill.receipt.failed", {
      phase,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordOrThrow(phase: "before" | "after", result: Probe): void {
  const { allowed, reason } = result;
  if (bundle === undefined) {
    say(`(no Remit for ${network.name}; the transition is not being recorded)`);
    return;
  }
  const remit = remitSchema.parse(bundle.remit);
  const { receipt, file } = appendReceipt(join(REPO, "receipts", network.name), {
    version: 1,
    at: Math.floor(Date.now() / 1000),
    network: network.name,
    chainId: network.chainId,
    remitHash: remitDigest(remit),
    strategyHash: remit.strategyHash,
    workflowHash: remit.workflowHash,
    limitsHash: remit.limitsHash,
    roleKey,
    safe,
    rolesModifier,
    agent,
    intent: probeIntent,
    action: {
      target: probeAction.target,
      signature: probeAction.signature,
      selector: probeAction.selector,
      description: `kill-switch probe (${phase}): ${probeAction.description}`,
      usd: "1",
    },
    gates: [
      {
        gate: "G1",
        outcome: "skipped",
        detail: "a reading of chain state, not a proposal",
      },
      // `skipped` when the chain never answered. A receipt that says the modifier
      // passed or refused is a receipt asserting a reading nobody took, and this record
      // exists precisely to be the evidence for the transition either side of it.
      result.answered
        ? {
            gate: "G2",
            outcome: allowed ? "pass" : "refused",
            code: allowed ? undefined : (result.code ?? "REFUSED"),
            detail: reason,
          }
        : {
            gate: "G2",
            outcome: "skipped",
            code: "RPC_UNREACHABLE",
            detail: reason,
          },
    ],
    // Nothing was proposed and nothing was submitted: this is a reading, and the
    // vocabulary has a word for that so a reader is never told a refusal happened to
    // an action somebody actually asked for.
    outcome: "observed",
    submission: {
      path: "none",
      executionId: null,
      workflowId: null,
      txHash: null,
      explorer: null,
      gasUsed: null,
    },
  });
  say(`receipt   ${file}  ${receipt.selfHash}`);
}

/** Three answers, not two. UNKNOWN is what an unreachable chain gets. */
function verdictOf(result: Probe): string {
  if (!result.answered) return "UNKNOWN";
  return result.allowed ? "PASS   " : "REFUSED";
}

// ---- before ---------------------------------------------------------------
const wasMember = await isRoleMember(network, rolesModifier, safe, agent, roleKey);
const before = await probe();
say(`agent     ${agent}`);
say(`member    ${wasMember}`);
say(`preflight ${verdictOf(before)} — ${before.reason}`);
record("before", before);
say("");

if (restore === wasMember) {
  say(
    restore
      ? "the agent is already a member — nothing to restore"
      : "the agent already has no authority — the switch is already pulled",
  );
  process.exit(0);
}

// ---- the one transaction --------------------------------------------------
say(restore ? "restoring membership…" : "pulling the kill switch…");
await assignRole(
  network,
  safe,
  cast.signingOwners,
  rolesModifier,
  agent,
  roleKey,
  restore,
);

// ---- after ----------------------------------------------------------------
const isMember = await isRoleMember(network, rolesModifier, safe, agent, roleKey);
const after = await probe();
say("");
say(`member    ${isMember}`);
say(`preflight ${verdictOf(after)} — ${after.reason}`);
record("after", after);

logEvent("kill", {
  network: network.name,
  agent,
  roleKey,
  restore,
  memberBefore: wasMember,
  memberAfter: isMember,
  allowedBefore: before.allowed,
  allowedAfter: after.allowed,
});

say("");

/**
 * The transaction landed; the proof that it took effect is a separate question.
 *
 * If the chain stopped answering between the two, neither claim can be made: not "it
 * worked" and not "it did not". Saying so is the only honest answer, and it is a
 * different exit code from a switch that demonstrably failed — an operator who is told
 * the revoke did not take effect will go and do something about it, and doing something
 * about a working switch is its own hazard.
 */
if (!after.answered) {
  say(`the ${restore ? "restore" : "revoke"} transaction landed on chain.`);
  say("Whether it took effect could not be read: the chain did not answer the probe.");
  say(
    `Re-run \`pnpm --filter ops kill --network ${network.name}\`${restore ? " --restore" : ""} when it does,`,
  );
  say("or read membership from any explorer. The transaction itself is above.");
  process.exit(3);
}

if (restore) {
  if (!after.allowed) fail("membership was restored but the agent still cannot act");
  say("the agent can act again, inside the preset and nowhere else");
} else {
  if (after.allowed)
    fail("the kill switch did not take effect — the agent can still act");
  say("the agent has no authority. Nothing in our stack was consulted to achieve that.");
}
