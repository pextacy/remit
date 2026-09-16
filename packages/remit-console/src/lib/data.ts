import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  DAY_SECONDS,
  decodeRevert,
  EXPLORER,
  erc20Abi,
  formatRevert,
  isUndecodable,
  type Limits,
  ledgerEntrySchema,
  limitsSchema,
  microsToUsd,
  type Receipt,
  type Remit,
  readChain,
  receiptSchema,
  remitDigest,
  remitSchema,
  rolesAbi,
  type SupportedChainId,
  spentMicros,
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
import { z } from "zod";
import { activeNetwork, DEPLOYMENTS_ROOT, RECEIPTS_ROOT, REMITS_ROOT } from "@/lib/paths";

/**
 * The deployment record, parsed rather than asserted.
 *
 * It used to be `readJson<Deployment>(…)` — a cast over whatever JSON was on disk. A file
 * written by an older tool, or half-written, or for a chain this build does not support,
 * therefore reached `USDC[chainId]` as `undefined` and `getAddress(undefined)` threw
 * inside a server component: the operator's screen went to an error boundary at the
 * moment its whole job was to say what was wrong. Every field the console reads is
 * checked here, once, and a file that does not parse is a *reported* fact.
 */
const deploymentSchema = z
  .object({
    safe: addressSchema,
    rolesModifier: addressSchema,
    roleKey: bytes32Schema,
    agentSigner: addressSchema,
    chainId: chainIdSchema,
    rolesDeployedBlock: z.number().int().min(0).optional(),
  })
  // The deployment file also carries `network`, `owners`, `threshold` and timestamps that
  // the console has no use for. Passing them through is fine; refusing the document
  // because it carries more than this screen reads would not be.
  .loose();

export type Deployment = z.infer<typeof deploymentSchema>;

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

/**
 * What the console found when it looked for a Remit.
 *
 * "Not issued yet" and "issued, and the file does not parse" are different facts, and an
 * operator needs to be told which. Collapsing them into `undefined` would show the
 * getting-started page to somebody whose Remit had been corrupted — the one reader who
 * most needs to be told something is wrong.
 */
export type BundleState =
  | { readonly kind: "ok"; readonly bundle: Bundle }
  | { readonly kind: "missing"; readonly network: string }
  | {
      readonly kind: "unreadable";
      readonly network: string;
      readonly problem: string;
      readonly detail: string;
    };

export function bundleState(): BundleState {
  const network = activeNetwork();
  const raw = readJson<{ remit: unknown; limits: unknown }>(
    join(REMITS_ROOT, `${network}.json`),
  );
  const onDisk = readJson<unknown>(join(DEPLOYMENTS_ROOT, `${network}.json`));
  if (raw === undefined || onDisk === undefined) {
    return { kind: "missing", network };
  }

  const deployment = deploymentSchema.safeParse(onDisk);
  if (!deployment.success) {
    return {
      kind: "unreadable",
      network,
      problem: `ops/deployments/${network}.json is not a deployment this build can read`,
      detail: issueOf(deployment.error),
    };
  }

  const remit = remitSchema.safeParse(raw.remit);
  if (!remit.success) {
    return {
      kind: "unreadable",
      network,
      problem: `ops/remits/${network}.json is not a Remit`,
      detail: issueOf(remit.error),
    };
  }

  const limits = limitsSchema.safeParse(raw.limits);
  if (!limits.success) {
    return {
      kind: "unreadable",
      network,
      problem: `ops/remits/${network}.json has no readable limits document`,
      detail: issueOf(limits.error),
    };
  }

  return {
    kind: "ok",
    bundle: {
      remit: remit.data,
      limits: limits.data,
      // Re-derived, not read: the file's claim about its own hash is the one thing
      // nothing else checks, and a console that displayed it unchecked would be a nice
      // place to hide a lie.
      remitHash: remitDigest(remit.data),
      deployment: deployment.data,
      network,
    },
  };
}

export function loadBundle(): Bundle | undefined {
  const state = bundleState();
  return state.kind === "ok" ? state.bundle : undefined;
}

function issueOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  if (issue === undefined) return "unparseable";
  const where = issue.path.length === 0 ? "the document" : issue.path.join(".");
  return `${where}: ${issue.message}`;
}

/**
 * The receipts, and the ones that are not receipts.
 *
 * A record that fails the schema is handed back separately rather than thrown on. The
 * console's whole job is to show an operator when something is wrong, and a page that
 * white-screens on the first bad file does the opposite of that.
 */
export function loadReceiptsAndProblems(): {
  receipts: readonly Receipt[];
  unreadable: readonly string[];
} {
  const dir = join(RECEIPTS_ROOT, activeNetwork());
  if (!existsSync(dir)) return { receipts: [], unreadable: [] };

  const receipts: Receipt[] = [];
  const unreadable: string[] = [];

  for (const entry of readChain(dir)) {
    const parsed = receiptSchema.safeParse(entry.receipt);
    if (parsed.success) receipts.push(parsed.data);
    else unreadable.push(entry.file);
  }

  return { receipts, unreadable };
}

export function loadReceipts(): readonly Receipt[] {
  return loadReceiptsAndProblems().receipts;
}

export type Integrity = {
  ok: boolean;
  count: number;
  head: string;
  problems: number;
  /** What is wrong, in the verifier's own words. Shown, not just counted. */
  detail: readonly { sequence: number; file: string; problem: string }[];
  /**
   * Receipts written under an earlier Remit, which these documents cannot speak to.
   *
   * Their hashes and links are checked like every other record. A Remit expires and is
   * reissued rather than widened, so a chain older than one Remit's life legitimately
   * names several — and an operator reading this screen should see that as history
   * rather than as damage.
   */
  underEarlierRemits: number;
};

export function chainIntegrity(): Integrity {
  const dir = join(RECEIPTS_ROOT, activeNetwork());
  if (!existsSync(dir)) {
    return {
      ok: true,
      count: 0,
      head: "—",
      problems: 0,
      detail: [],
      underEarlierRemits: 0,
    };
  }

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
    // A count alone sends the operator to a terminal to find out what is wrong, which is
    // the moment this page stops being worth opening.
    detail: verification.problems.map((problem) => ({
      sequence: problem.sequence,
      file: problem.file,
      problem: `${problem.problem} (expected ${problem.expected}, got ${problem.actual})`,
    })),
    underEarlierRemits: verification.uncheckedAgainstDocuments.length,
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

/**
 * Was this attempt refused?
 *
 * Not simply "did it execute". `observed` is a reading of chain state that nobody
 * proposed — the kill switch writes two of them — and `unresolved` is an execution we
 * could not correlate a hash to. Neither is a refusal, and drawing them in full ink would
 * make the one thing ink means on these screens mean something else as well.
 */
export function wasRefused(outcome: Receipt["outcome"]): boolean {
  return (
    outcome === "rejected_g1" ||
    outcome === "rejected_g2" ||
    outcome === "declined_g3" ||
    outcome === "reverted_g4"
  );
}

/**
 * What a receipt proposed, in dollars, whether or not a call was ever built.
 *
 * A refusal at G1 has `action: null` — the intent never reached the compiler — so the
 * amount has to come from the intent itself. That matters most in exactly the case the
 * remit line was drawn for: an action refused *for being too large* is the one whose
 * measure should visibly cross the cap, and it is also the one with no compiled action to
 * read a figure from. USDC has six decimals, so a base unit is a micro-dollar and the
 * conversion is exact — the same assumption G1 makes, for the same reason.
 */
export function proposedUsd(receipt: Receipt): number | undefined {
  if (receipt.action !== null) return Number(receipt.action.usd);
  if (receipt.intent.kind === "unparseable") return undefined;
  if (receipt.intent.asset !== "USDC") return undefined;
  return Number(receipt.intent.amount) / 10 ** USDC_DECIMALS;
}

/** Spend in the last 24 hours, from the receipts rather than from a separate ledger. */
/**
 * What the daily cap has actually been charged, and whether we could read it.
 *
 * The number G1 enforces comes from `ops/deployments/<network>.ledger.json` — the file
 * the ops pipeline and the bridge both append to. This used to be derived from the
 * receipts instead, and the two are not the same history: `exec` and `p1` move value on
 * the hand-run path without touching either, and the demo scenarios write `executed`
 * receipts of their own. So the screen could say 20 USD left while the gate believed 25,
 * which is the one number on this page an operator would act on.
 *
 * Read through the same function the gate uses, over the same file, with the same window.
 *
 * An unreadable ledger is reported rather than shown as zero. Zero spend is the reading
 * that makes the remit look emptiest of commitments and fullest of headroom, and it is
 * exactly the reading a truncated file would produce.
 */
export type Spend =
  | { readonly known: true; readonly usd: number }
  | { readonly known: false; readonly problem: string };

export function spentToday(): Spend {
  const path = join(DEPLOYMENTS_ROOT, `${activeNetwork()}.ledger.json`);
  if (!existsSync(path)) return { known: true, usd: 0 };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      known: false,
      problem: `${activeNetwork()}.ledger.json is not JSON (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }

  const entries = z.array(ledgerEntrySchema).safeParse(raw);
  if (!entries.success) {
    return {
      known: false,
      problem: `${activeNetwork()}.ledger.json is not a ledger: ${issueOf(entries.error)}`,
    };
  }

  const micros = spentMicros(entries.data, Math.floor(Date.now() / 1000), DAY_SECONDS);
  return { known: true, usd: Number(microsToUsd(micros)) };
}

/**
 * An environment variable set to nothing is not a value.
 *
 * `?? fallback` only catches `undefined`, and `.env.example` ships the optional RPCs as
 * `NAME=` with nothing after — which is how an operator is told to leave one unset.
 * Sourcing that handed viem an empty URL, and the console reported the chain as
 * unreachable on a screen whose whole job is to say what is actually wrong.
 */
function envUrl(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function rpcUrl(network: string): string {
  if (network === "anvil") return envUrl("ANVIL_RPC_URL", "http://127.0.0.1:8545");
  if (network === "anvil-base") {
    return envUrl("ANVIL_BASE_RPC_URL", "http://127.0.0.1:8547");
  }
  if (network === "base") return envUrl("BASE_RPC_URL", "https://mainnet.base.org");
  return envUrl("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org");
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
      // Decoded against the pinned Roles ABI, not matched against the text of an error.
      // `NotAuthorized(address)` comes from the `moduleOnly` guard — the caller is not
      // even enabled as a module — and `NoMembership()` one layer in. Any other refusal
      // means the role let the call through and something further in said no, which is a
      // true answer to a different question. Reading the string instead would make this
      // page's answer depend on how a provider chose to phrase an error.
      const decoded = decodeRevert(error);

      if (isUndecodable(decoded)) {
        return {
          isMember: false,
          reason:
            "the modifier refused with something this build cannot name — " +
            "this is not a reading of the kill switch",
          safeUsdc: formatUnits(safeUsdc, USDC_DECIMALS),
          reachable: false,
        };
      }

      if (
        decoded.kind === "roles_error" &&
        (decoded.name === "NoMembership" || decoded.name === "NotAuthorized")
      ) {
        isMember = false;
        reason = `the kill switch is pulled — the agent has no authority (${formatRevert(decoded)})`;
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
