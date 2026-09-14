/**
 * PLAN.md 1.2 — deploy a Roles v2 instance, enable it on the Safe, put the agent signer
 * in the role.
 *
 *   pnpm --filter ops roles:deploy --network anvil
 */
import { type Hex, keccak256, stringToHex, toHex } from "viem";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { explorerAddress } from "../lib/clients.js";
import { requireDeployment, requireField, writeDeployment } from "../lib/deployment.js";
import { logEvent, say } from "../lib/log.js";
import {
  assignRole,
  deployRolesModifier,
  enableModule,
  isEnabledOnRoles,
  isRoleMember,
} from "../lib/roles.js";

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");

/**
 * A readable role key beats a hashed one: it shows up as text in an explorer, and an
 * operator checking the kill switch can see at a glance which role they are revoking.
 */
const roleKey = stringToHex(option(args, "role") ?? "remit-agent", { size: 32 }) as Hex;
const salt = BigInt(keccak256(toHex(option(args, "salt") ?? "remit-p1")));

const { rolesModifier, block } = await deployRolesModifier(
  network,
  cast.deployer,
  safe,
  salt,
);
await enableModule(network, safe, cast.signingOwners, rolesModifier);
await assignRole(
  network,
  safe,
  cast.signingOwners,
  rolesModifier,
  cast.agent.address,
  roleKey,
  true,
);

const enabled = await isEnabledOnRoles(network, rolesModifier, cast.agent.address);
const member = await isRoleMember(
  network,
  rolesModifier,
  safe,
  cast.agent.address,
  roleKey,
);

writeDeployment({
  network: network.name,
  chainId: network.chainId,
  rolesModifier,
  rolesDeployedBlock: Number(block),
  roleKey,
  agentSigner: cast.agent.address,
  updatedAt: new Date().toISOString(),
});

say(`roles ${rolesModifier}  ${explorerAddress(network.chainId, rolesModifier)}`);
say(`role  ${roleKey}  member=${cast.agent.address} enabled=${enabled} member=${member}`);
logEvent("p1.2.done", { rolesModifier, roleKey, enabled, member });

if (!enabled || !member) {
  logEvent("fatal", { message: "agent signer is not a member of the role" });
  process.exit(1);
}
