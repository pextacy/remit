/**
 * PLAN.md 1.3 (apply half) — apply the preset to the role.
 *
 *   pnpm --filter ops roles:apply --network anvil
 *
 * Every call goes through the Safe, because the Safe owns the Roles instance. The preset
 * is printed before anything is sent; `roles:diff` in P4 will make that a real diff
 * against what is already on chain rather than a description of what we are about to do.
 */
import {
  buildPreset,
  describePreset,
  diffRole,
  encodePreset,
  readRole,
  renderDiff,
} from "@remit/core";
import { castFor } from "../lib/actors.js";
import { networkFrom, parseArgs } from "../lib/args.js";
import { publicClientFor } from "../lib/clients.js";
import { requireDeployment, requireField, writeDeployment } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";
import { execSafeTx, safeCall } from "../lib/safe.js";

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

const preset = buildPreset(network.chainId, roleKey);
say(describePreset(preset, safe));
say("");

/**
 * The diff runs first, always (PRD.md §9).
 *
 * Printing what is about to be applied is not the same as printing what will *change*.
 * The second is the one that catches a preset that was edited in a way nobody intended,
 * and it costs one event scan.
 */
const onChain = await readRole(publicClientFor(network), rolesModifier, roleKey, {
  fromBlock: BigInt(deployment.rolesDeployedBlock ?? 0),
});
const deltas = diffRole(preset, onChain);

say(
  renderDiff(deltas, {
    roleKey,
    rolesModifier,
    asOfBlock: onChain.asOfBlock,
    events: onChain.eventsReplayed,
  }),
);
say("");

if (deltas.length === 0) {
  say("nothing to apply — the chain already says what the preset says");
  logEvent("roles.apply.noop", { rolesModifier, roleKey });
  process.exit(0);
}

const widenings = deltas.filter((delta) => delta.widens);
if (widenings.length > 0 && !args.flags.has("yes") && network.isMainnet) {
  fail(
    `${widenings.length} change(s) would widen the agent's authority on mainnet — ` +
      "re-run with --yes once you have read every [WIDENS AUTHORITY] line above",
  );
}

for (const call of encodePreset(preset)) {
  await execSafeTx(
    network,
    safe,
    cast.signingOwners,
    safeCall(rolesModifier, call.data),
    `preset: ${call.label}`,
  );
}

writeDeployment({
  network: network.name,
  chainId: network.chainId,
  presetAppliedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

logEvent("p1.3.done", {
  rolesModifier,
  roleKey,
  targets: preset.targets.length,
  functions: preset.functions.length,
});
