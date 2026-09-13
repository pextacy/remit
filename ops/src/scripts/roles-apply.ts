/**
 * PLAN.md 1.3 (apply half) — apply the preset to the role.
 *
 *   pnpm --filter ops roles:apply --network anvil
 *
 * Every call goes through the Safe, because the Safe owns the Roles instance. The preset
 * is printed before anything is sent; `roles:diff` in P4 will make that a real diff
 * against what is already on chain rather than a description of what we are about to do.
 */
import { castFor } from "../lib/actors.js";
import { networkFrom, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField, writeDeployment } from "../lib/deployment.js";
import { logEvent, say } from "../lib/log.js";
import { execSafeTx, safeCall } from "../lib/safe.js";
import { describePreset, encodePreset } from "../roles/encode.js";
import { buildPreset } from "../roles/preset.js";

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
