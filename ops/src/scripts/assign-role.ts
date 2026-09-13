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
import { requireDeployment, requireField } from "../lib/deployment.js";
import { logEvent, say } from "../lib/log.js";
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
say(`${member} member=${after}`);
logEvent("role.membership", { member, roleKey, granted: grant, observed: after });
