/**
 * Where a deployment is written down.
 *
 * One JSON file per network under `ops/deployments/`, so every script after the first can
 * find the Safe and the Roles instance without being told again, and so the addresses a
 * receipt refers to are reviewable in the repository rather than living in someone's
 * shell history. No key material is ever written here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { fail, logEvent } from "./log.js";
import type { NetworkName } from "./networks.js";

export type Deployment = {
  network: NetworkName;
  chainId: number;
  safe?: Address;
  owners?: readonly Address[];
  threshold?: number;
  rolesModifier?: Address;
  /** The block the Roles instance was deployed in — where `roles:diff` starts replaying. */
  rolesDeployedBlock?: number;
  roleKey?: Hex;
  agentSigner?: Address;
  /**
   * The highest Remit nonce ever issued for this (safe, roleKey).
   *
   * Kept here rather than derived from `ops/remits/<network>.json`, which is the file
   * `remit:issue` is about to overwrite: reading the next nonce out of it meant restoring
   * an older Remit walked the sequence backwards, and the next issue produced a second,
   * different Remit wearing a nonce that was already taken. "A reissued Remit never
   * collides with its ancestor" is the whole reason the field exists.
   *
   * The pair it belongs to is stored with it, so a new Safe or a new role starts its own
   * sequence rather than inheriting somebody else's high-water mark.
   */
  lastRemit?: { safe: Address; roleKey: Hex; nonce: string };
  presetAppliedAt?: string;
  updatedAt: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS_DIR = join(HERE, "..", "..", "deployments");

function pathFor(network: NetworkName): string {
  return join(DEPLOYMENTS_DIR, `${network}.json`);
}

export function readDeployment(network: NetworkName): Deployment | undefined {
  try {
    return JSON.parse(readFileSync(pathFor(network), "utf8")) as Deployment;
  } catch {
    return undefined;
  }
}

export function requireDeployment(network: NetworkName): Deployment {
  const deployment = readDeployment(network);
  if (deployment === undefined) {
    fail(`no deployment for ${network} — run safe:deploy and roles:deploy first`);
  }
  return deployment;
}

export function writeDeployment(patch: Deployment): Deployment {
  const existing = readDeployment(patch.network);
  const merged: Deployment = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  writeFileSync(pathFor(patch.network), `${JSON.stringify(merged, null, 2)}\n`);
  logEvent("deployment.written", {
    network: patch.network,
    file: pathFor(patch.network),
  });
  return merged;
}

export function requireField<K extends keyof Deployment>(
  deployment: Deployment,
  key: K,
): NonNullable<Deployment[K]> {
  const value = deployment[key];
  if (value === undefined)
    fail(`deployment for ${deployment.network} has no ${String(key)}`);
  return value as NonNullable<Deployment[K]>;
}
