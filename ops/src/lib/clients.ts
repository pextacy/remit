/**
 * Chain clients, and the two ways this repository is allowed to act as an address.
 *
 * On a fork we impersonate: no key exists, so none can leak. On a real network the key
 * comes from the environment and never from a file in the repository (CLAUDE.md §2.4).
 */

import { EXPLORER, type SupportedChainId } from "@remit/core";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hash,
  type Hex,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fail, logEvent } from "./log.js";
import type { Network } from "./networks.js";

export type Sender =
  /** An address unlocked by anvil. Signing is the node's problem. */
  | { readonly kind: "impersonated"; readonly address: Address }
  /** A local key from the environment, used to sign transactions and Safe digests. */
  | {
      readonly kind: "local";
      readonly address: Address;
      readonly sign: (hash: Hash) => Promise<Hex>;
      readonly privateKey: Hex;
    };

export function chainFor(network: Network) {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
  });
}

export function publicClientFor(network: Network): PublicClient {
  return createPublicClient({
    chain: chainFor(network),
    transport: http(network.rpcUrl),
  }) as PublicClient;
}

export function walletClientFor(network: Network): WalletClient {
  return createWalletClient({
    chain: chainFor(network),
    transport: http(network.rpcUrl),
  });
}

/** Build a sender from a private key in the environment. */
export function senderFromEnv(envVar: string): Sender {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") fail(`${envVar} is not set`);
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  const account = privateKeyToAccount(key);
  return {
    kind: "local",
    address: account.address,
    sign: async (hash: Hash) => account.sign({ hash }),
    privateKey: key,
  };
}

/** Unlock an address on a fork. Fails loudly anywhere else. */
export async function impersonate(
  network: Network,
  address: Address,
  fundWei = 10n ** 18n,
): Promise<Sender> {
  if (!network.canImpersonate) {
    fail(`cannot impersonate ${address} on ${network.name} — that only works on a fork`);
  }
  const client = publicClientFor(network);
  await client.request({
    method: "anvil_impersonateAccount" as never,
    params: [address] as never,
  });
  await client.request({
    method: "anvil_setBalance" as never,
    params: [address, `0x${fundWei.toString(16)}`] as never,
  });
  return { kind: "impersonated", address };
}

export type SendOptions = {
  /**
   * Skip gas estimation with an explicit limit. Required when the transaction is
   * *expected* to revert: estimation runs the call first and would throw before the
   * chain ever sees it, and a revert we never sent is not evidence of anything.
   */
  readonly gas?: bigint;
  /** Return the failed receipt instead of exiting. The out-of-preset probe needs this. */
  readonly allowRevert?: boolean;
};

export type SendResult = {
  readonly hash: Hash;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
};

/** Send a transaction as a sender of either kind. */
export async function sendTx(
  network: Network,
  sender: Sender,
  tx: { to: Address; data?: Hex; value?: bigint },
  label: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const wallet = walletClientFor(network);
  const chain = chainFor(network);
  const account =
    sender.kind === "impersonated"
      ? sender.address
      : privateKeyToAccount(sender.privateKey);

  const request = {
    account,
    chain,
    to: tx.to,
    data: tx.data ?? "0x",
    value: tx.value ?? 0n,
    ...(options.gas === undefined ? {} : { gas: options.gas }),
  } as Parameters<typeof wallet.sendTransaction>[0];

  const hash = await wallet.sendTransaction(request);
  const receipt = await publicClientFor(network).waitForTransactionReceipt({ hash });

  logEvent("tx", {
    label,
    network: network.name,
    from: sender.address,
    to: tx.to,
    txHash: hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    link: explorerTx(network.chainId, hash),
  });

  if (receipt.status !== "success" && options.allowRevert !== true) {
    fail(`${label} reverted on chain: ${hash}`);
  }

  return { hash, status: receipt.status, gasUsed: receipt.gasUsed };
}

/** The common case: send, and treat a revert as fatal. */
export async function send(
  network: Network,
  sender: Sender,
  tx: { to: Address; data?: Hex; value?: bigint },
  label: string,
): Promise<Hash> {
  const result = await sendTx(network, sender, tx, label);
  return result.hash;
}

/**
 * Wait for the node to answer.
 *
 * A fork that was started seconds ago will accept a connection before its upstream RPC is
 * warm, and the first write then fails for a reason that has nothing to do with the code
 * under it. One run of P1 was lost to exactly that; a readiness check is cheaper than
 * re-reading a stack trace.
 */
export async function waitForNode(network: Network, attempts = 20): Promise<void> {
  const client = publicClientFor(network);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.getBlockNumber();
      // A fork also needs its upstream to answer an archival read, which getBlockNumber
      // does not prove. One cheap state read does.
      await client.getCode({ address: "0x000000000000aDdB49795b0f9bA5BC298cDda236" });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export function explorerTx(chainId: SupportedChainId, hash: Hash): string {
  return `${EXPLORER[chainId]}/tx/${hash}`;
}

export function explorerAddress(chainId: SupportedChainId, address: Address): string {
  return `${EXPLORER[chainId]}/address/${address}`;
}
