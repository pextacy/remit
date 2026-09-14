import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPLORER,
  erc20Abi,
  type Limits,
  limitsSchema,
  type Receipt,
  type Remit,
  readChain,
  remitDigest,
  remitSchema,
  rolesAbi,
  type SupportedChainId,
  USDC,
  USDC_DECIMALS,
  verifyReceiptChain,
} from "@remit/core";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  type PublicClient,
} from "viem";
import { activeNetwork, DEPLOYMENTS_ROOT, RECEIPTS_ROOT, REMITS_ROOT } from "@/lib/paths";

export type Deployment = {
  safe: `0x${string}`;
  rolesModifier: `0x${string}`;
  roleKey: `0x${string}`;
  agentSigner: `0x${string}`;
  chainId: SupportedChainId;
  rolesDeployedBlock?: number;
};

export type Bundle = {
  remit: Remit;
  limits: Limits;
  remitHash: `0x${string}`;
  deployment: Deployment;
  network: string;
};

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function loadBundle(): Bundle | undefined {
  const network = activeNetwork();
  const raw = readJson<{ remit: unknown; limits: unknown }>(
    join(REMITS_ROOT, `${network}.json`),
  );
  const deployment = readJson<Deployment>(join(DEPLOYMENTS_ROOT, `${network}.json`));
  if (raw === undefined || deployment === undefined) return undefined;

  const remit = remitSchema.parse(raw.remit);
  const limits = limitsSchema.parse(raw.limits);

  return {
    remit,
    limits,
    // Re-derived, not read: the file's claim about its own hash is the one thing nothing
    // else checks, and a console that displayed it unchecked would be a nice place to
    // hide a lie.
    remitHash: remitDigest(remit),
    deployment,
    network,
  };
}

export function loadReceipts(): readonly Receipt[] {
  const dir = join(RECEIPTS_ROOT, activeNetwork());
  if (!existsSync(dir)) return [];
  return readChain(dir).map((entry) => entry.receipt as Receipt);
}

export function chainIntegrity(): {
  ok: boolean;
  count: number;
  head: string;
  problems: number;
} {
  const dir = join(RECEIPTS_ROOT, activeNetwork());
  if (!existsSync(dir)) return { ok: true, count: 0, head: "—", problems: 0 };

  const bundle = loadBundle();
  const verification = verifyReceiptChain(
    readChain(dir),
    bundle === undefined ? undefined : { remit: bundle.remit, limits: bundle.limits },
  );

  return {
    ok: verification.ok,
    count: verification.count,
    head: verification.head,
    problems: verification.problems.length,
  };
}

/** Gate counters (CN-5). Attempts and refusals at each gate, from the receipts alone. */
export type GateCounters = Record<
  "G1" | "G2" | "G3" | "G4",
  { attempts: number; refused: number }
>;

export function gateCounters(receipts: readonly Receipt[]): GateCounters {
  const counters: GateCounters = {
    G1: { attempts: 0, refused: 0 },
    G2: { attempts: 0, refused: 0 },
    G3: { attempts: 0, refused: 0 },
    G4: { attempts: 0, refused: 0 },
  };

  for (const receipt of receipts) {
    for (const gate of receipt.gates) {
      if (gate.outcome === "skipped") continue;
      const counter = counters[gate.gate];
      counter.attempts += 1;
      if (
        gate.outcome === "refused" ||
        gate.outcome === "declined" ||
        gate.outcome === "reverted"
      ) {
        counter.refused += 1;
      }
    }
  }

  return counters;
}

/** Spend in the last 24 hours, from the receipts rather than from a separate ledger. */
export function spentTodayUsd(receipts: readonly Receipt[]): number {
  const cutoff = Math.floor(Date.now() / 1000) - 86_400;
  return receipts
    .filter(
      (receipt) =>
        receipt.outcome === "executed" &&
        receipt.intent.kind === "supply" &&
        receipt.at > cutoff,
    )
    .reduce((total, receipt) => total + Number(receipt.action?.usd ?? 0), 0);
}

function rpcUrl(network: string): string {
  if (network === "anvil") return process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
  if (network === "anvil-base") {
    return process.env.ANVIL_BASE_RPC_URL ?? "http://127.0.0.1:8547";
  }
  if (network === "base") return process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  return process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
}

export function clientFor(bundle: Bundle): PublicClient {
  return createPublicClient({ transport: http(rpcUrl(bundle.network)) }) as PublicClient;
}

export type LiveState = {
  isMember: boolean;
  reason: string;
  safeUsdc: string;
  /** Unreachable chain is reported, never guessed at. */
  reachable: boolean;
};

/**
 * The kill-switch screen's live reading (CN-3).
 *
 * Membership is observed by simulating a call under the role, because Roles 2.1.0 has no
 * getter for it. `NoMembership` or `NotAuthorized` means no; anything else means the
 * membership check passed before something further in refused.
 */
export async function readLiveState(bundle: Bundle): Promise<LiveState> {
  const client = clientFor(bundle);

  try {
    const safeUsdc = (await client.readContract({
      address: getAddress(USDC[bundle.deployment.chainId]),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [bundle.remit.safe],
    })) as bigint;

    let isMember = true;
    let reason = "the agent can act, inside the preset and nowhere else";

    try {
      await client.simulateContract({
        address: bundle.deployment.rolesModifier,
        abi: rolesAbi,
        functionName: "execTransactionWithRole",
        args: [bundle.remit.safe, 0n, "0x", 0, bundle.remit.roleKey, true],
        account: bundle.deployment.agentSigner,
      });
    } catch (error) {
      const message = String(error);
      if (/NoMembership|NotAuthorized|0x4a0bfec1/.test(message)) {
        isMember = false;
        reason = "the kill switch is pulled — the agent has no authority";
      }
    }

    return {
      isMember,
      reason,
      safeUsdc: formatUnits(safeUsdc, USDC_DECIMALS),
      reachable: true,
    };
  } catch {
    return {
      isMember: false,
      reason: "the chain could not be reached — this is not a reading of the kill switch",
      safeUsdc: "—",
      reachable: false,
    };
  }
}

export function explorerFor(chainId: SupportedChainId): string {
  return EXPLORER[chainId];
}
