/**
 * The rolling spend ledger, on disk.
 *
 * G1 is pure and takes the ledger as an argument (PRD.md G1-1); something has to hold it
 * between runs, and that is this file. Plain JSON next to the deployment, so the daily cap
 * survives a restart (G1-5) and an operator can read what the agent has spent without
 * running anything.
 *
 * Entries are append-only and carry no addresses — only when, how much, and which kind.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerEntry } from "@remit/core";
import type { NetworkName } from "./networks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "..", "deployments");

function pathFor(network: NetworkName): string {
  return join(DIR, `${network}.ledger.json`);
}

export function readLedger(network: NetworkName): readonly LedgerEntry[] {
  try {
    return JSON.parse(readFileSync(pathFor(network), "utf8")) as LedgerEntry[];
  } catch {
    return [];
  }
}

export function appendLedger(
  network: NetworkName,
  entry: LedgerEntry,
): readonly LedgerEntry[] {
  const entries = [...readLedger(network), entry];
  mkdirSync(DIR, { recursive: true });
  writeFileSync(pathFor(network), `${JSON.stringify(entries, null, 2)}\n`);
  return entries;
}
