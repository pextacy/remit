/**
 * What the Roles Modifier actually says, read back off the chain.
 *
 * Roles 2.1.0 exposes **no getter** for a role's targets, functions or conditions. The
 * state is there — `scopeConfig` is a mapping inside a struct — but nothing public reads
 * it, and `eth_getStorageAt` against a packed mapping is the kind of cleverness that is
 * wrong six months later without telling anyone.
 *
 * The contract does, however, emit everything it does: `ScopeTarget`, `ScopeFunction`
 * (with the whole condition tree in the log), `AllowTarget`, `AllowFunction`,
 * `RevokeTarget`, `RevokeFunction`, `AssignRoles`. Replaying those in order reconstructs
 * the role exactly, from the contract's own account of itself.
 *
 * That is what makes `roles:diff` a real diff rather than a description of what we are
 * about to send.
 */

import { type Address, getAddress, type Hex, type PublicClient } from "viem";
import { rolesAbi } from "../chain/abi/roles.js";
import { Clearance, type ConditionFlat, ExecutionOptions } from "../chain/roles-enums.js";

export type OnChainFunction = {
  readonly selector: Hex;
  readonly options: number;
  /** Undefined when the function was allowed unconditionally rather than scoped. */
  readonly conditions: readonly ConditionFlat[] | undefined;
};

export type OnChainTarget = {
  readonly address: Address;
  readonly clearance: number;
  /** Only meaningful at `Clearance.Target`; a scoped target's options live per function. */
  readonly options: number;
  readonly functions: ReadonlyMap<Hex, OnChainFunction>;
};

export type OnChainRole = {
  readonly roleKey: Hex;
  readonly targets: ReadonlyMap<Address, OnChainTarget>;
  readonly members: ReadonlyMap<Address, boolean>;
  /** The block the reconstruction is current as of. */
  readonly asOfBlock: bigint;
  readonly eventsReplayed: number;
};

type MutableTarget = {
  address: Address;
  clearance: number;
  options: number;
  functions: Map<Hex, OnChainFunction>;
};

/**
 * Replay the role's history.
 *
 * `fromBlock` should be the block the Roles instance was deployed in — everything before
 * it is by definition not about this instance. Public RPCs cap the range of a single
 * `eth_getLogs`, so the scan is chunked rather than asked for in one call.
 */
export async function readRole(
  client: PublicClient,
  rolesModifier: Address,
  roleKey: Hex,
  options: { fromBlock?: bigint; chunk?: bigint } = {},
): Promise<OnChainRole> {
  const latest = await client.getBlockNumber();
  const fromBlock = options.fromBlock ?? 0n;
  // 10,000 is the range cap the public Base RPCs enforce (and that an anvil fork
  // forwards). Asking for more gets a 413 with a message nobody reads until they have
  // lost twenty minutes to it.
  const chunk = options.chunk ?? 10_000n;

  const targets = new Map<Address, MutableTarget>();
  const members = new Map<Address, boolean>();
  let eventsReplayed = 0;

  const upsert = (address: Address): MutableTarget => {
    const existing = targets.get(address);
    if (existing !== undefined) return existing;
    const created: MutableTarget = {
      address,
      clearance: Clearance.None,
      options: ExecutionOptions.None,
      functions: new Map(),
    };
    targets.set(address, created);
    return created;
  };

  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;

    const logs = await client.getLogs({
      address: rolesModifier,
      fromBlock: start,
      toBlock: end,
    });

    // viem needs the ABI to decode; ask for everything on this address and decode what
    // we recognise. A log we cannot decode is a contract we do not understand, and
    // silently skipping it here would be how a diff misses a permission.
    const decoded = await client.getContractEvents({
      address: rolesModifier,
      abi: rolesAbi,
      fromBlock: start,
      toBlock: end,
    });

    if (decoded.length !== logs.length) {
      throw new Error(
        `${logs.length - decoded.length} log(s) from ${rolesModifier} did not decode ` +
          "against the pinned Roles ABI — the deployment is not the version we verified",
      );
    }

    for (const event of decoded) {
      eventsReplayed += 1;
      const args = event.args as Record<string, unknown>;

      switch (event.eventName) {
        case "AssignRoles": {
          const keys = (args.roleKeys as readonly Hex[]) ?? [];
          const memberOf = (args.memberOf as readonly boolean[]) ?? [];
          keys.forEach((key, index) => {
            if (key.toLowerCase() !== roleKey.toLowerCase()) return;
            members.set(getAddress(args.module as Address), memberOf[index] ?? false);
          });
          break;
        }
        case "ScopeTarget": {
          if ((args.roleKey as Hex).toLowerCase() !== roleKey.toLowerCase()) break;
          const target = upsert(getAddress(args.targetAddress as Address));
          target.clearance = Clearance.Function;
          break;
        }
        case "AllowTarget": {
          if ((args.roleKey as Hex).toLowerCase() !== roleKey.toLowerCase()) break;
          const target = upsert(getAddress(args.targetAddress as Address));
          target.clearance = Clearance.Target;
          target.options = Number(args.options);
          break;
        }
        case "RevokeTarget": {
          if ((args.roleKey as Hex).toLowerCase() !== roleKey.toLowerCase()) break;
          const target = upsert(getAddress(args.targetAddress as Address));
          target.clearance = Clearance.None;
          target.functions.clear();
          break;
        }
        case "ScopeFunction": {
          if ((args.roleKey as Hex).toLowerCase() !== roleKey.toLowerCase()) break;
          const target = upsert(getAddress(args.targetAddress as Address));
          const selector = args.selector as Hex;
          target.functions.set(selector, {
            selector,
            options: Number(args.options),
            conditions: (args.conditions as readonly ConditionFlat[]).map(
              (condition) => ({
                parent: Number(condition.parent),
                paramType: condition.paramType,
                operator: condition.operator,
                compValue: condition.compValue,
              }),
            ),
          });
          break;
        }
        case "AllowFunction": {
          if ((args.roleKey as Hex).toLowerCase() !== roleKey.toLowerCase()) break;
          const target = upsert(getAddress(args.targetAddress as Address));
          const selector = args.selector as Hex;
          target.functions.set(selector, {
            selector,
            options: Number(args.options),
            conditions: undefined,
          });
          break;
        }
        case "RevokeFunction": {
          if ((args.roleKey as Hex).toLowerCase() !== roleKey.toLowerCase()) break;
          upsert(getAddress(args.targetAddress as Address)).functions.delete(
            args.selector as Hex,
          );
          break;
        }
        default:
          break;
      }
    }
  }

  return {
    roleKey,
    targets: new Map(
      [...targets.entries()].map(([address, target]) => [
        address,
        {
          address: target.address,
          clearance: target.clearance,
          options: target.options,
          functions: target.functions,
        },
      ]),
    ),
    members,
    asOfBlock: latest,
    eventsReplayed,
  };
}
