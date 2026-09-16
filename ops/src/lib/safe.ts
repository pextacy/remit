/**
 * Deploying a Safe, and getting an owner-signed transaction out of one.
 *
 * Everything here talks to the canonical v1.4.1 deployments listed in `@remit/core`.
 * No contract in this repository is written by us (CLAUDE.md §2.6).
 */

import {
  Operation,
  SAFE_L2_SINGLETON,
  SAFE_PROXY_FACTORY,
  safeAbi,
  safeProxyFactoryAbi,
} from "@remit/core";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { publicClientFor, type Sender, send } from "./clients.js";
import { fail, logEvent } from "./log.js";
import type { Network } from "./networks.js";

/**
 * Safe v1.4.1 compatibility fallback handler.
 *
 * Source: safe-global/safe-deployments `src/assets/v1.4.1/compatibility_fallback_handler.json`
 * at commit 7b1fb6d615ab2d2999550ec9166554b180e813e5 — `canonical` on both 8453 and 84532.
 * Verified 2026-09-13, see docs/VERIFIED.md.
 */
export const SAFE_FALLBACK_HANDLER: Address =
  "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

export type SafeTx = {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly operation: number;
};

/**
 * Deploy a Safe through the canonical proxy factory.
 *
 * `saltNonce` makes the address deterministic per (owners, threshold, salt), so re-running
 * this with the same salt returns the existing Safe instead of a second one.
 */
export async function deploySafe(
  network: Network,
  deployer: Sender,
  params: {
    owners: readonly Address[];
    threshold: number;
    saltNonce: bigint;
  },
): Promise<{ safe: Address; txHash: Hash | null }> {
  if (params.threshold < 1 || params.threshold > params.owners.length) {
    fail(
      `threshold ${params.threshold} is not reachable with ${params.owners.length} owners`,
    );
  }

  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [
      params.owners.map((owner) => getAddress(owner)),
      BigInt(params.threshold),
      zeroAddress, // no setup delegatecall: nothing runs at deployment time
      "0x",
      SAFE_FALLBACK_HANDLER,
      zeroAddress, // paymentToken
      0n, // payment
      zeroAddress, // paymentReceiver
    ],
  });

  const client = publicClientFor(network);
  // `createProxyWithNonce` is not a view function, so ask for its return value the only
  // way that does not write: simulate it. The address it reports is the address the real
  // call will produce, because the factory is CREATE2 over (initializer, saltNonce).
  const simulated = await client.simulateContract({
    address: SAFE_PROXY_FACTORY,
    abi: safeProxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [SAFE_L2_SINGLETON, initializer, params.saltNonce],
    account: deployer.address,
  });
  const predicted = getAddress(simulated.result as Address);

  const existing = await client.getCode({ address: predicted });
  if (existing !== undefined && existing !== "0x") {
    logEvent("safe.exists", { safe: predicted });
    return { safe: predicted, txHash: null };
  }

  const txHash = await send(
    network,
    deployer,
    {
      to: SAFE_PROXY_FACTORY,
      data: encodeFunctionData({
        abi: safeProxyFactoryAbi,
        functionName: "createProxyWithNonce",
        args: [SAFE_L2_SINGLETON, initializer, params.saltNonce],
      }),
    },
    "safe.deploy",
  );

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  const [creation] = parseEventLogs({
    abi: safeProxyFactoryAbi,
    eventName: "ProxyCreation",
    logs: receipt.logs,
  });
  const safe = creation === undefined ? predicted : getAddress(creation.args.proxy);

  logEvent("safe.deployed", {
    safe,
    owners: params.owners,
    threshold: params.threshold,
    txHash,
  });
  return { safe, txHash };
}

/**
 * Execute a transaction from the Safe, signed by enough owners to meet the threshold.
 *
 * Two signature paths, both native to Safe 1.4.1:
 *
 * - **impersonated owners** (fork only) pre-approve the digest with `approveHash` and the
 *   signature is the `v = 1` form, which makes the Safe check `approvedHashes` instead of
 *   running `ecrecover`. No key is involved, so no key can leak.
 * - **local owners** sign the digest itself; `v = 27/28` is the EIP-712 path.
 *
 * Signatures must be ordered by ascending owner address — the Safe walks them that way
 * to reject duplicates.
 */
export async function execSafeTx(
  network: Network,
  safe: Address,
  owners: readonly Sender[],
  tx: SafeTx,
  label: string,
): Promise<Hash> {
  const client = publicClientFor(network);

  const nonce = (await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "nonce",
  })) as bigint;

  const safeTxHash = (await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      0n, // safeTxGas
      0n, // baseGas
      0n, // gasPrice
      zeroAddress, // gasToken
      zeroAddress, // refundReceiver
      nonce,
    ],
  })) as Hash;

  const ordered = [...owners].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  );

  const parts: Hex[] = [];
  for (const owner of ordered) {
    if (owner.kind === "local") {
      const signature = await owner.sign(safeTxHash);
      parts.push(signature.slice(2) as Hex);
      continue;
    }

    await send(
      network,
      owner,
      {
        to: safe,
        data: encodeFunctionData({
          abi: safeAbi,
          functionName: "approveHash",
          args: [safeTxHash],
        }),
      },
      `${label}.approveHash`,
    );
    // r = owner address left-padded to 32 bytes, s = 0, v = 1: the pre-approved form.
    const r = owner.address.slice(2).toLowerCase().padStart(64, "0");
    parts.push(`${r}${"0".repeat(64)}01` as Hex);
  }

  const signatures = `0x${parts.join("")}` as Hex;

  const hash = await send(
    network,
    ordered[0] ?? fail("no owners supplied"),
    {
      to: safe,
      data: encodeFunctionData({
        abi: safeAbi,
        functionName: "execTransaction",
        args: [
          tx.to,
          tx.value,
          tx.data,
          tx.operation,
          0n,
          0n,
          0n,
          zeroAddress,
          zeroAddress,
          signatures,
        ],
      }),
    },
    label,
  );

  // Do not return until the Safe's own nonce has moved.
  //
  // The *next* Safe transaction reads `nonce()` to build its digest, and a public RPC is
  // a pool of nodes: that read can be answered by one that has not yet seen this
  // transaction, even though its receipt is already in hand. The digest is then built for
  // a nonce that is already spent, the signature recovers to an address that is not an
  // owner, and the Safe answers **GS026 — invalid owner** for a signature that was
  // perfectly good.
  //
  // `roles:apply` sends five of these back to back, so this is not a corner; it cost a
  // reverted `scopeTarget` and its gas on Base Sepolia. It is invisible on a fork, where
  // there is one node and no lag to have.
  await waitForNonceAfter(network, safe, nonce, label);

  return hash;
}

/**
 * Wait until the Safe reports a nonce past the one just consumed.
 *
 * Bounded, and a refusal rather than an assumption: carrying on against a node that
 * cannot see the transaction we hold a receipt for means the next digest is built on a
 * reading nobody should trust.
 */
async function waitForNonceAfter(
  network: Network,
  safe: Address,
  used: bigint,
  label: string,
  attempts = 40,
): Promise<void> {
  const client = publicClientFor(network);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = (await client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "nonce",
    })) as bigint;
    if (current > used) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(
    `${label} landed but ${safe} still reports nonce ${used} after ` +
      `${(attempts * 500) / 1000}s. The RPC is behind the chain; a transaction built on ` +
      "that reading would be signed for a nonce that is already spent.",
  );
}

/** A plain call from the Safe to a target. Remit never sends `DelegateCall`. */
export function safeCall(to: Address, data: Hex, value = 0n): SafeTx {
  return { to, value, data, operation: Operation.Call };
}
