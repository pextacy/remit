/**
 * Deploying a Zodiac Roles v2 instance for a Safe, enabling it, and moving membership.
 *
 * The Roles instance is owned by the Safe and its avatar and target are the Safe. That
 * ownership is what makes the kill switch real: revoking the agent is one owner
 * transaction, needs no coordination with us, and consults nothing in our stack.
 */

import {
  decodeRevert,
  extractRevertData,
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
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  type PublicClient,
  parseEventLogs,
} from "viem";
import { publicClientFor, type Sender, send } from "./clients.js";
import { fail, logEvent } from "./log.js";
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

/**
 * Deploy a Roles proxy through the Zodiac ModuleProxyFactory — or reuse the recorded one.
 *
 * The factory is CREATE2 over `(mastercopy, initializer, saltNonce)`, so a second call
 * with the same three cannot deploy. It reverts with `TakenAddress(address(0))` — the
 * zero is not a mistake in the ABI, the factory passes the failed `create2` result — so
 * the collision says *that* something is there and never *what*.
 *
 * That asymmetry with `deploySafe`, which predicts its address and returns the existing
 * proxy, only bites after a partial failure. The real cause is upstream of it and is
 * fixed in `deploy-roles.ts`: the deployment record used to be written last, so a proxy
 * deployed successfully and a later step that failed left the address on chain and
 * nowhere else, and every re-run hit the collision with nothing to fall back on.
 *
 * So `known` is the recorded address, and it is checked rather than believed: a proxy
 * whose `avatar()` is not this Safe is not this deployment's.
 */
export async function deployRolesModifier(
  network: Network,
  deployer: Sender,
  safe: Address,
  saltNonce: bigint,
  options: { known?: Address } = {},
): Promise<{ rolesModifier: Address; txHash: Hash | null; block: bigint | null }> {
  const client = publicClientFor(network);
  const initializer = rolesInitializer(safe);

  if (options.known !== undefined && (await isRolesFor(client, options.known, safe))) {
    logEvent("roles.exists", { rolesModifier: options.known, safe });
    return { rolesModifier: getAddress(options.known), txHash: null, block: null };
  }

  try {
    await client.simulateContract({
      address: MODULE_PROXY_FACTORY,
      abi: moduleProxyFactoryAbi,
      functionName: "deployModule",
      args: [ROLES_MASTERCOPY, initializer, saltNonce],
      account: deployer.address,
    });
  } catch (error) {
    const data = extractRevertData(error);
    const taken =
      data !== undefined &&
      (() => {
        try {
          return decodeErrorResult({ abi: moduleProxyFactoryAbi, data }).errorName;
        } catch {
          return undefined;
        }
      })() === "TakenAddress";

    if (!taken) throw error;

    // "Execution reverted for an unknown reason" is what this used to be. Say what it is
    // and what to do, because neither is guessable from the factory's own answer.
    fail(
      "a Roles proxy for this Safe and salt already exists, and the factory does not " +
        "say where — it reverts with TakenAddress(0). The deployment record for " +
        `${network.name} does not name one either, so this run cannot find it. Either ` +
        "pass a different --salt to deploy a second instance, or read the address off " +
        "the ModuleProxyCreation event on the explorer and put it in " +
        `ops/deployments/${network.name}.json as "rolesModifier" before re-running.`,
    );
  }

  const txHash = await send(
    network,
    deployer,
    {
      to: MODULE_PROXY_FACTORY,
      data: encodeFunctionData({
        abi: moduleProxyFactoryAbi,
        functionName: "deployModule",
        args: [ROLES_MASTERCOPY, initializer, saltNonce],
      }),
    },
    "roles.deploy",
  );

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const [creation] = parseEventLogs({
    abi: moduleProxyFactoryAbi,
    eventName: "ModuleProxyCreation",
    logs: receipt.logs,
  });

  if (creation === undefined) {
    throw new Error(`ModuleProxyCreation not emitted in ${txHash}`);
  }

  const rolesModifier = getAddress(creation.args.proxy);
  logEvent("roles.deployed", {
    rolesModifier,
    safe,
    txHash,
    block: receipt.blockNumber.toString(),
  });
  return { rolesModifier, txHash, block: receipt.blockNumber };
}

/**
 * Is this address a Roles instance belonging to this Safe?
 *
 * A recorded address is a file's claim. `avatar()` is the chain's, and the two have to
 * agree before a run carries on with it — a stale record naming somebody else's modifier
 * would otherwise be enabled as a module on this Safe.
 */
async function isRolesFor(
  client: PublicClient,
  candidate: Address,
  safe: Address,
): Promise<boolean> {
  try {
    const avatar = (await client.readContract({
      address: getAddress(candidate),
      abi: rolesAbi,
      functionName: "avatar",
    })) as Address;
    return getAddress(avatar) === getAddress(safe);
  } catch {
    return false;
  }
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
      // Two different failures wear the same face here, and the message has to say
      // which: a chain that never answered carries no revert data either, so this used
      // to tell an operator their ABI had drifted when their RPC was simply down.
      const unanswered = decoded.kind === "undecodable" && decoded.data === "0x";
      throw new Error(
        unanswered
          ? "membership could not be read: the chain did not answer the probe. This is " +
              "not a reading of the role — nothing was concluded about it. " +
              `(${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`
          : `membership probe returned an undecodable revert: ${formatRevert(decoded)}`,
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
