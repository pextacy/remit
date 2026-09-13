/**
 * What is actually true on chain right now.
 *
 * The console's kill-switch screen answers the same question in P9; this is the same
 * reads from a terminal, and it is what an operator runs after pulling the switch to
 * confirm it took effect. Reads only, no key, no gas.
 *
 *   pnpm --filter ops status --network anvil
 *   pnpm --filter ops status --network anvil --member 0x…
 */

import { AAVE_V3_POOL, erc20Abi, safeAbi, USDC, USDC_DECIMALS } from "@remit/core";
import { formatUnits, getAddress } from "viem";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { explorerAddress, publicClientFor } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { logEvent, say } from "../lib/log.js";
import { isEnabledOnRoles, isRoleMember } from "../lib/roles.js";

const args = parseArgs();
const network = networkFrom(args);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");
const agent = requireField(deployment, "agentSigner");

const memberArg = option(args, "member");
const member = memberArg === undefined ? agent : getAddress(memberArg);

const client = publicClientFor(network);
const usdc = getAddress(USDC[network.chainId]);

const [owners, threshold, moduleEnabled, balance] = await Promise.all([
  client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
  client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
  client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "isModuleEnabled",
    args: [rolesModifier],
  }),
  client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [safe],
  }),
]);

const enabledOnRoles = await isEnabledOnRoles(network, rolesModifier, member);
const roleMember = await isRoleMember(network, rolesModifier, safe, member, roleKey);

say(`network   ${network.name} (chain ${network.chainId})`);
say(`safe      ${safe}  ${explorerAddress(network.chainId, safe)}`);
say(`owners    ${(owners as readonly string[]).join(", ")}`);
say(`threshold ${threshold as bigint} of ${(owners as readonly string[]).length}`);
say(`usdc      ${formatUnits(balance as bigint, USDC_DECIMALS)} (${usdc})`);
say(`venue     ${getAddress(AAVE_V3_POOL[network.chainId])}`);
say("");
say(`roles     ${rolesModifier}  module enabled on safe: ${moduleEnabled as boolean}`);
say(`role      ${roleKey}`);
say(`member    ${member}`);
say(`          enabled as module on roles: ${enabledOnRoles}`);
say(`          member of the role:         ${roleMember}`);
say("");
say(
  roleMember
    ? "the agent can act, inside the preset and nowhere else"
    : "the agent has no authority — the kill switch is pulled",
);

logEvent("status", {
  network: network.name,
  safe,
  rolesModifier,
  roleKey,
  member,
  moduleEnabled,
  enabledOnRoles,
  roleMember,
  safeUsdc: (balance as bigint).toString(),
});
