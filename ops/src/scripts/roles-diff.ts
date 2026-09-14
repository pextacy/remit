/**
 * PLAN.md 2.6 — the permission delta, before anything is applied.
 *
 *   pnpm --filter ops roles:diff --network anvil
 *
 * Reads the role back off the chain by replaying the Roles Modifier's own events, then
 * compares it with the preset this repository would apply. Every difference is printed,
 * and the ones that would give the agent *more* than it has are marked.
 *
 * Reads only. It cannot change anything, which is why it is safe to run against mainnet
 * without a flag.
 */
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { logEvent, say } from "../lib/log.js";
import { diffRole, renderDiff } from "../roles/diff.js";
import { readRole } from "../roles/onchain.js";
import { buildPreset } from "../roles/preset.js";

const args = parseArgs();
const network = networkFrom(args, { readOnly: true });
const deployment = requireDeployment(network.name);
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

// Everything before the Roles instance existed is, by definition, not about this role.
const fromBlock = BigInt(
  option(args, "from-block") ?? String(deployment.rolesDeployedBlock ?? 0),
);

const onChain = await readRole(network, rolesModifier, roleKey, { fromBlock });
const preset = buildPreset(network.chainId, roleKey);
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
say("members of this role, on chain:");
const members = [...onChain.members.entries()].filter(([, isMember]) => isMember);
if (members.length === 0) {
  say("  none — the role grants nobody anything right now");
} else {
  for (const [member] of members) {
    say(`  ${member}${member === deployment.agentSigner ? "  (the agent signer)" : ""}`);
  }
}

logEvent("roles.diff", {
  network: network.name,
  rolesModifier,
  roleKey,
  differences: deltas.length,
  widenings: deltas.filter((delta) => delta.widens).length,
  members: members.length,
  asOfBlock: onChain.asOfBlock.toString(),
});

// A non-empty diff is not a failure — it is the normal state before an apply. The exit
// code distinguishes them so a script can tell without parsing the prose.
process.exit(deltas.length === 0 ? 0 : 1);
