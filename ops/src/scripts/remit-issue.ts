/**
 * `remit issue` — build a Remit, hash it, write it down.
 *
 *   pnpm --filter ops remit:issue --network anvil \
 *     --strategy path/to/strategy.py \
 *     --workflow ops/workflows/exec-with-role.workflow.json
 *
 * Both hashes come from real files. There is no default and no placeholder: a Remit whose
 * `strategyHash` does not correspond to source someone can read is a Remit that proves
 * nothing, and inventing one to make the command succeed is the exact failure CLAUDE.md
 * §2.1 exists to prevent.
 *
 * Signing is RM-5 and is P1-priority, not P0: the on-chain authority is the Roles preset,
 * and an unsigned Remit still binds every hash the receipt chain needs. Owners sign with
 * `eth_signTypedData_v4` over `remitTypedData` when that lands.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalHash,
  canonicalJson,
  limitsHash,
  type Remit,
  remitDigest,
  remitSchema,
} from "@remit/core";
import { type Hex, keccak256, toBytes } from "viem";
import { networkFrom, option, parseArgs, requireOption } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";
import { buildLimits } from "../remit/limits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const args = parseArgs();
const network = networkFrom(args);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

/**
 * pnpm runs a filtered script from the package directory, so a path a person typed
 * relative to the repository root would not resolve. Try both, in the order that matches
 * what they meant.
 */
function resolvePath(path: string): string {
  if (isAbsolute(path)) return path;
  const fromCwd = resolve(process.cwd(), path);
  if (existsSync(fromCwd)) return fromCwd;
  return resolve(REPO, path);
}

/** keccak256 of the file's bytes, exactly as committed. No normalisation, no reformatting. */
function hashFile(path: string): Hex {
  try {
    return keccak256(toBytes(readFileSync(path, "utf8")));
  } catch {
    return fail(`cannot read ${path}`);
  }
}

/**
 * The workflow is hashed through the canonical serialiser rather than as raw bytes: it is
 * a JSON document, and reformatting it must not change what the Remit binds.
 */
function hashWorkflow(path: string): Hex {
  try {
    return canonicalHash(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return fail(`cannot read or parse ${path}`);
  }
}

const strategyPath = resolvePath(requireOption(args, "strategy"));
const workflowPath = resolvePath(requireOption(args, "workflow"));

const limits = buildLimits(network.chainId, safe, {
  ...(option(args, "per-tx") === undefined
    ? {}
    : { perTxCapUsd: requireOption(args, "per-tx") }),
  ...(option(args, "daily") === undefined
    ? {}
    : { dailyCapUsd: requireOption(args, "daily") }),
});

const now = Math.floor(Date.now() / 1000);
const validForDays = Number(option(args, "days") ?? "7");

const remit: Remit = remitSchema.parse({
  strategyHash: hashFile(strategyPath),
  workflowHash: hashWorkflow(workflowPath),
  safe,
  rolesModifier,
  roleKey,
  limitsHash: limitsHash(limits),
  chainId: network.chainId,
  notBefore: now,
  // An expiry is not a formality: it is the difference between authority the operator
  // granted and authority they forgot about.
  notAfter: now + validForDays * 86_400,
  nonce: option(args, "nonce") ?? "1",
} satisfies Record<string, unknown>);

const remitHash = remitDigest(remit);

const bundle = {
  remitHash,
  remit,
  limits,
  sources: {
    strategy: relative(REPO, strategyPath),
    workflow: relative(REPO, workflowPath),
  },
  issuedAt: new Date(now * 1000).toISOString(),
};

const outDir = join(REPO, "ops", "remits");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${network.name}.json`);
writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);

say(`remitHash    ${remitHash}`);
say(`limitsHash   ${remit.limitsHash}`);
say(`strategyHash ${remit.strategyHash}  ${bundle.sources.strategy}`);
say(`workflowHash ${remit.workflowHash}  ${bundle.sources.workflow}`);
say(`safe         ${remit.safe}`);
say(`roles        ${remit.rolesModifier}  role ${remit.roleKey}`);
say(`valid        ${remit.notBefore} → ${remit.notAfter} (${validForDays}d)`);
say(`caps         ${limits.perTxCapUsd} USD per tx, ${limits.dailyCapUsd} USD per day`);
say(`written      ${relative(REPO, outPath)}`);
say("");
say("canonical limits bytes, which anyone can re-hash:");
say(`  ${canonicalJson(limits)}`);

logEvent("remit.issued", {
  remitHash,
  network: network.name,
  file: relative(REPO, outPath),
});
