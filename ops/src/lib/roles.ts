/**
 * Deploying a Zodiac Roles v2 instance for a Safe, enabling it, and moving membership.
 *
 * The Roles instance is owned by the Safe and its avatar and target are the Safe. That
 * ownership is what makes the kill switch real: revoking the agent is one owner
 * transaction, needs no coordination with us, and consults nothing in our stack.
 */

import {
  decodeRevert,
  formatRevert,
  isUndecodable,
  MODULE_PROXY_FACTORY,
  moduleProxyFactoryAbi,
  Operation,
  ROLES_MASTERCOPY,
  rolesAbi,
  safeAbi,
} from "@remit/core";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  parseEventLogs,
} from "viem";
import { publicClientFor, type Sender, send } from "./clients.js";
import { logEvent } from "./log.js";
import type { Network } from "./networks.js";
import { execSafeTx, safeCall } from "./safe.js";

/**
 * `setUp(bytes)` on Roles decodes `(owner, avatar, target)`.
 * Source: `packages/evm/contracts/Roles.sol` lines 51-63 at the pinned tag.
 */
export function rolesInitializer(safe: Address): Hex {
  const initParams = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [safe, safe, safe],
  );
  return encodeFunctionData({ abi: rolesAbi, functionName: "setUp", args: [initParams] });
}

/** Deploy a Roles proxy through the Zodiac ModuleProxyFactory. */
export async function deployRolesModifier(
  network: Network,
  deployer: Sender,
  safe: Address,
  saltNonce: bigint,
): Promise<{ rolesModifier: Address; txHash: Hash }> {
  const txHash = await send(
    network,
    deployer,
    {
      to: MODULE_PROXY_FACTORY,
      data: encodeFunctionData({
        abi: moduleProxyFactoryAbi,
        functionName: "deployModule",
        args: [ROLES_MASTERCOPY, rolesInitializer(safe), saltNonce],
      }),
    },
    "roles.deploy",
  );

  const receipt = await publicClientFor(network).getTransactionReceipt({ hash: txHash });
  const [creation] = parseEventLogs({
    abi: moduleProxyFactoryAbi,
    eventName: "ModuleProxyCreation",
    logs: receipt.logs,
  });

  if (creation === undefined) {
    throw new Error(`ModuleProxyCreation not emitted in ${txHash}`);
  }

  const rolesModifier = getAddress(creation.args.proxy);
  logEvent("roles.deployed", { rolesModifier, safe, txHash });
  return { rolesModifier, txHash };
}

/** Enable the Roles instance as a Safe module. Owner transaction. */
export async function enableModule(
  network: Network,
  safe: Address,
  owners: readonly Sender[],
  module: Address,
): Promise<Hash | null> {
  const client = publicClientFor(network);
  const already = (await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "isModuleEnabled",
    args: [module],
  })) as boolean;

  if (already) {
    logEvent("safe.module.already-enabled", { safe, module });
    return null;
  }

  return execSafeTx(
    network,
    safe,
    owners,
    safeCall(
      safe,
      encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [module] }),
    ),
    "safe.enableModule",
  );
}

/**
 * Grant or revoke membership of a role.
 *
 * Revoking is the kill switch (`PRD.md` CN-3): one owner transaction, instant, total.
 */
export async function assignRole(
  network: Network,
  safe: Address,
  owners: readonly Sender[],
  rolesModifier: Address,
  member: Address,
  roleKey: Hex,
  isMember: boolean,
): Promise<Hash> {
  return execSafeTx(
    network,
    safe,
    owners,
    safeCall(
      rolesModifier,
      encodeFunctionData({
        abi: rolesAbi,
        functionName: "assignRoles",
        args: [member, [roleKey], [isMember]],
      }),
    ),
    isMember ? "roles.assign" : "roles.revoke",
  );
}

/**
 * Is this address a member of this role right now?
 *
 * Roles 2.1.0 exposes no getter for the members mapping, so membership is observed the
 * only way it can be: simulate a call under the role and look at which error comes back.
 * `NoMembership()` means no; anything else — typically `ConditionViolation` or
 * `TargetAddressNotAllowed` for this deliberately empty call — means the membership check
 * was passed before the condition check failed.
 *
 * Costs no gas. `isModuleEnabled` is not a substitute: `assignRoles` enables a member as
 * a module when granting, but revoking the role does not disable it again.
 */
export async function isRoleMember(
  network: Network,
  rolesModifier: Address,
  safe: Address,
  member: Address,
  roleKey: Hex,
): Promise<boolean> {
  try {
    await publicClientFor(network).simulateContract({
      address: rolesModifier,
      abi: rolesAbi,
      functionName: "execTransactionWithRole",
      args: [safe, 0n, "0x", Operation.Call, roleKey, true],
      account: member,
    });
    return true;
  } catch (error) {
    const decoded = decodeRevert(error);
    // Two different refusals mean "not a member". `NotAuthorized(address)` comes from the
    // `moduleOnly` guard — the caller is not even enabled as a module. `NoMembership()`
    // comes one layer in — enabled, but not in this role. Treating only the second as a
    // negative answer would report a stranger as a member.
    if (
      decoded.kind === "roles_error" &&
      (decoded.name === "NoMembership" || decoded.name === "NotAuthorized")
    ) {
      return false;
    }
    if (isUndecodable(decoded)) {
      throw new Error(
        `membership probe returned an undecodable revert: ${formatRevert(decoded)}`,
      );
    }
    return true;
  }
}

/** Is this address enabled as a module on the Roles instance? Necessary, not sufficient. */
export async function isEnabledOnRoles(
  network: Network,
  rolesModifier: Address,
  member: Address,
): Promise<boolean> {
  return (await publicClientFor(network).readContract({
    address: rolesModifier,
    abi: rolesAbi,
    functionName: "isModuleEnabled",
    args: [member],
  })) as boolean;
}
