/**
 * Grant or revoke the agent's membership.
 *
 *   pnpm --filter ops role:assign --network anvil            # grant
 *   pnpm --filter ops role:assign --network anvil --revoke   # the kill switch
 *
 * Revoking is one owner transaction. It is instant, total, and consults nothing in this
 * repository — which is the property that makes it worth having.
 */
import { getAddress } from "viem";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField, writeDeployment } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";
import { assignRole, isRoleMember } from "../lib/roles.js";

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

const memberArg = option(args, "member");
const member = memberArg === undefined ? cast.agent.address : getAddress(memberArg);
const grant = !args.flags.has("revoke");
const recorded = deployment.agentSigner;

/**
 * Granting to somebody who is not the recorded agent takes an extra word, and moves the
 * record with it.
 *
 * `kill`, `status` and `mainnet:preflight` all act on `deployment.agentSigner` — it is
 * the single place this repository writes down *who the agent is*. Granting the role to
 * another address left that field pointing at the old one, so the kill switch revoked an
 * address that no longer mattered and reported success: the agent that actually held
 * authority kept it, and every screen said the switch was pulled.
 *
 * So the two cannot drift. Either this is the recorded agent, or the operator says they
 * are changing who the agent is and the file changes with the chain.
 */
if (grant && recorded !== undefined && getAddress(recorded) !== member) {
  if (!args.flags.has("new-agent")) {
    fail(
      `${member} is not the agent recorded for ${network.name} (${getAddress(recorded)}). ` +
        "Granting the role to it would give it the whole preset while `kill` carried on " +
        "revoking the other address — the switch would report success and stop nothing. " +
        "Re-run with --new-agent to make this the agent of record, or revoke the old one " +
        "first with `role:assign --revoke`.",
    );
  }

  say(`agent     ${getAddress(recorded)} → ${member} (--new-agent)`);
  say("          the previous agent may still be a member: revoke it explicitly with");
  say(
    `          pnpm --filter ops role:assign --network ${network.name} ` +
      `--revoke --member ${getAddress(recorded)}`,
  );
}

await assignRole(
  network,
  safe,
  cast.signingOwners,
  rolesModifier,
  member,
  roleKey,
  grant,
);

const after = await isRoleMember(network, rolesModifier, safe, member, roleKey);

// Written after the chain agreed, not before: a record of an agent that is not one is
// worse than no record, because every later command believes it.
if (grant && after && (recorded === undefined || getAddress(recorded) !== member)) {
  writeDeployment({
    network: network.name,
    chainId: network.chainId,
    agentSigner: member,
    updatedAt: new Date().toISOString(),
  });
}

say(`${member} member=${after}`);
logEvent("role.membership", {
  member,
  roleKey,
  granted: grant,
  observed: after,
  ...(recorded === undefined ? {} : { previousAgent: getAddress(recorded) }),
});
