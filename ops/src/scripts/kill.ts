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
import { preflight } from "../lib/exec-role.js";
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
async function probe(): Promise<{ allowed: boolean; reason: string }> {
  const result = await preflight(network, rolesModifier, roleKey, agent, {
    label: probeAction.description,
    target: probeAction.target,
    data: probeAction.calldata,
  });

  if (result.ok) {
    return { allowed: true, reason: "the Roles Modifier would allow it" };
  }

  const decoded = result.decoded;
  const refusedByRole =
    decoded.kind === "roles_condition_violation" ||
    (decoded.kind === "roles_error" &&
      (decoded.name === "NoMembership" || decoded.name === "NotAuthorized"));

  return refusedByRole
    ? { allowed: false, reason: result.reason }
    : {
        allowed: true,
        reason: `the role allowed it; the call itself would fail (${result.reason})`,
      };
}

function record(phase: "before" | "after", allowed: boolean, reason: string): void {
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
      {
        gate: "G2",
        outcome: allowed ? "pass" : "refused",
        code: allowed ? undefined : "NoMembership",
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

// ---- before ---------------------------------------------------------------
const wasMember = await isRoleMember(network, rolesModifier, safe, agent, roleKey);
const before = await probe();
say(`agent     ${agent}`);
say(`member    ${wasMember}`);
say(`preflight ${before.allowed ? "PASS" : "REFUSED"} — ${before.reason}`);
record("before", before.allowed, before.reason);
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
say(`preflight ${after.allowed ? "PASS" : "REFUSED"} — ${after.reason}`);
record("after", after.allowed, after.reason);

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
if (restore) {
  if (!after.allowed) fail("membership was restored but the agent still cannot act");
  say("the agent can act again, inside the preset and nowhere else");
} else {
  if (after.allowed)
    fail("the kill switch did not take effect — the agent can still act");
  say("the agent has no authority. Nothing in our stack was consulted to achieve that.");
}
