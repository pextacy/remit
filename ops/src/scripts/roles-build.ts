/**
 * PLAN.md 1.3 (build half) — print the preset, and the calls that would apply it.
 *
 *   pnpm --filter ops roles:build --network anvil
 *
 * Reading this output is the control. Applying a preset nobody read is how an agent ends
 * up with authority nobody intended.
 */
import { networkFrom, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { say } from "../lib/log.js";
import { describePreset, encodePreset } from "../roles/encode.js";
import { buildPreset } from "../roles/preset.js";

const args = parseArgs();
const network = networkFrom(args, { readOnly: true });
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const roleKey = requireField(deployment, "roleKey");

const preset = buildPreset(network.chainId, roleKey);

say(describePreset(preset, safe));
say("");
say(`calls to apply (${encodePreset(preset).length}, all from the Safe as Roles owner):`);
for (const call of encodePreset(preset)) say(`  ${call.label}`);
