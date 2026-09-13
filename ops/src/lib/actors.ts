/**
 * Who is acting, and where their authority comes from.
 *
 * On a fork: anvil's unlocked accounts, addressed by index. No key exists anywhere, which
 * is the point — a repository that never holds a key cannot leak one.
 *
 * On a real network: keys from the environment, named per role. The agent signer and the
 * Safe owners are deliberately different variables; an agent key that is also an owner key
 * makes every gate downstream decorative.
 */
import { type Address, getAddress } from "viem";
import { impersonate, publicClientFor, type Sender, senderFromEnv } from "./clients.js";
import { fail } from "./log.js";
import type { Network } from "./networks.js";

export async function anvilAccounts(network: Network): Promise<readonly Address[]> {
  const accounts = (await publicClientFor(network).request({
    method: "eth_accounts" as never,
    params: [] as never,
  })) as readonly Address[];
  if (accounts.length < 5) fail("expected anvil to expose at least 5 unlocked accounts");
  return accounts.map((account) => getAddress(account));
}

export type Cast = {
  /** Pays for deployments. On a fork, anvil's account 0. */
  readonly deployer: Sender;
  /** Every owner address that goes into `setup`, whether or not we hold its key. */
  readonly ownerAddresses: readonly Address[];
  /** The owners this machine can actually sign for. */
  readonly owners: readonly Sender[];
  /** The threshold's worth of owners, for signing. */
  readonly signingOwners: readonly Sender[];
  /** The EOA that is a member of the role. Never an owner. */
  readonly agent: Sender;
  /** Somewhere funds must never be able to go. Used by the out-of-preset probe. */
  readonly attacker: Address;
};

export async function castFor(network: Network): Promise<Cast> {
  if (network.canImpersonate) {
    const accounts = await anvilAccounts(network);
    const [deployer, agent, ownerA, ownerB, ownerC, attacker] = accounts as [
      Address,
      Address,
      Address,
      Address,
      Address,
      Address,
    ];
    const owners = await Promise.all([
      impersonate(network, ownerA),
      impersonate(network, ownerB),
      impersonate(network, ownerC),
    ]);
    return {
      deployer: await impersonate(network, deployer),
      ownerAddresses: [ownerA, ownerB, ownerC],
      owners,
      signingOwners: owners.slice(0, 2),
      agent: await impersonate(network, agent),
      attacker,
    };
  }

  const owners = [
    senderFromEnv("SAFE_OWNER_1_PRIVATE_KEY"),
    senderFromEnv("SAFE_OWNER_2_PRIVATE_KEY"),
  ];
  const attacker = process.env.ATTACKER_ADDRESS;
  const third = process.env.SAFE_OWNER_3_ADDRESS;
  return {
    deployer: owners[0] ?? fail("SAFE_OWNER_1_PRIVATE_KEY is required"),
    // The third owner is an address we do not hold a key for — a hardware wallet, or a
    // teammate. 2-of-3 with two hot keys would make the third owner decoration.
    ownerAddresses: [
      ...owners.map((owner) => owner.address),
      third === undefined
        ? fail("SAFE_OWNER_3_ADDRESS is required off-fork: the cold third owner")
        : getAddress(third),
    ],
    owners,
    signingOwners: owners,
    agent: senderFromEnv("AGENT_SIGNER_PRIVATE_KEY"),
    attacker:
      attacker === undefined
        ? fail("ATTACKER_ADDRESS is required off-fork: pick an address you control")
        : getAddress(attacker),
  };
}
