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
import { buildPreset, diffRole, readRole, renderDiff } from "@remit/core";
import { getAddress } from "viem";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { publicClientFor } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";

const args = parseArgs();
const network = networkFrom(args, { readOnly: true });
const deployment = requireDeployment(network.name);
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

// Everything before the Roles instance existed is, by definition, not about this role.
const fromBlockArg = option(args, "from-block");
if (fromBlockArg !== undefined && !/^(0|[1-9][0-9]*)$/.test(fromBlockArg)) {
  // `BigInt("n")` throws a SyntaxError from somewhere unrelated. The operator typed a
  // flag; the message should name the flag.
  fail(`--from-block must be a block number, not "${fromBlockArg}"`);
}
const fromBlock = BigInt(fromBlockArg ?? String(deployment.rolesDeployedBlock ?? 0));

const onChain = await readRole(publicClientFor(network), rolesModifier, roleKey, {
  fromBlock,
});
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
/**
 * Checksummed on both sides before comparing.
 *
 * `onChain.members` is keyed by `getAddress`; the deployment file is a file, and a
 * lowercase address in it would have made every member read as a stranger — or, worse,
 * the agent read as one.
 */
const agentOfRecord =
  deployment.agentSigner === undefined ? undefined : getAddress(deployment.agentSigner);

if (members.length === 0) {
  say("  none — the role grants nobody anything right now");
} else {
  for (const [member] of members) {
    if (member === agentOfRecord) {
      say(`  ${member}  (the agent signer)`);
      continue;
    }
    // A member nobody recorded is the gap between `role:assign --member` and every
    // command that acts on `deployment.agentSigner`. `kill` revokes the agent of record
    // and reports success; this address keeps the whole preset.
    say(`  ${member}  [NOT THE AGENT OF RECORD — kill does not revoke this address]`);
  }
}

const strangers = members.filter(([member]) => member !== agentOfRecord);
if (strangers.length > 0) {
  say("");
  say(
    `${strangers.length} member(s) of this role are not the agent recorded for ` +
      `${network.name}${agentOfRecord === undefined ? "" : ` (${agentOfRecord})`}. ` +
      "Revoke them, or make one of them the agent of record with " +
      "`role:assign --new-agent`.",
  );
}

logEvent("roles.diff", {
  network: network.name,
  rolesModifier,
  roleKey,
  differences: deltas.length,
  widenings: deltas.filter((delta) => delta.widens).length,
  members: members.length,
  strangers: strangers.length,
  asOfBlock: onChain.asOfBlock.toString(),
});

// A non-empty diff is not a failure — it is the normal state before an apply. The exit
// code distinguishes them so a script can tell without parsing the prose.
// A member nobody recorded is a difference between the chain and this repository even
// when the preset itself matches, and it is the kind an operator has to act on.
process.exit(deltas.length === 0 && strangers.length === 0 ? 0 : 1);
