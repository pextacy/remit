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
  limitsSchema,
  type Remit,
  remitDigest,
  remitSchema,
  usdToMicros,
} from "@remit/core";
import { type Hex, keccak256, toBytes } from "viem";
import { networkFrom, option, parseArgs, requireOption } from "../lib/args.js";
import { requireDeployment, requireField, writeDeployment } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";
import { buildLimits, widenings } from "../remit/limits.js";

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

const daysArg = option(args, "days") ?? "7";
const validForDays = Number(daysArg);
if (!Number.isInteger(validForDays) || validForDays < 1 || validForDays > 365) {
  // `Number("a week")` is NaN, and `notAfter: now + NaN` is NaN — which the schema would
  // refuse, several lines later, with a message about `notAfter` rather than about the
  // flag the operator actually typed.
  fail(`--days must be a whole number of days between 1 and 365, not "${daysArg}"`);
}

/**
 * The next nonce for this (safe, roleKey).
 *
 * The field is documented as monotonic, and it was hard-coded to "1" unless an operator
 * remembered the flag — so reissuing produced a Remit whose only difference from its
 * ancestor was `notBefore`. Two Remits at the same nonce is exactly the ambiguity the
 * field exists to remove: a receipt naming one of them cannot say which.
 *
 * Read from the Remit already on disk, because that is what the last issue produced, and
 * an operator who wants to start again can still say `--nonce`.
 */
function nextNonce(): string {
  const explicit = option(args, "nonce");
  if (explicit !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(explicit)) {
      fail(`--nonce must be an unsigned integer, not "${explicit}"`);
    }
    return explicit;
  }

  const previous = readPreviousRemit();
  const fromFile =
    previous !== undefined && previous.safe === safe && previous.roleKey === roleKey
      ? BigInt(previous.nonce)
      : 0n;

  /**
   * The high-water mark, from the deployment record rather than from the Remit file.
   *
   * Reading the sequence out of the file this command is about to overwrite meant
   * restoring an older Remit walked it backwards: issue #1, issue #2, put #1 back, issue
   * again — and the new document takes nonce 2, which #2 already has. Two different
   * Remits at one nonce is exactly the ambiguity the field exists to remove, and a
   * receipt naming that nonce cannot say which of them it meant.
   *
   * The deployment record is written by different commands and is not the thing being
   * rolled back, so the two have to disagree before the sequence can repeat.
   */
  const highWater =
    deployment.lastRemit !== undefined &&
    deployment.lastRemit.safe === safe &&
    deployment.lastRemit.roleKey === roleKey
      ? BigInt(deployment.lastRemit.nonce)
      : 0n;

  const highest = fromFile > highWater ? fromFile : highWater;
  // A different role or a different Safe is a different sequence, and continuing the old
  // one would suggest a lineage that is not there.
  return (highest + 1n).toString();
}

function readPreviousRemit(): Remit | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(REPO, "ops", "remits", `${network.name}.json`), "utf8"),
    ) as { remit?: unknown };
    const parsed = remitSchema.safeParse(raw.remit);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const previousRemit = readPreviousRemit();
const previousLimits = (() => {
  if (previousRemit === undefined) return undefined;
  if (previousRemit.safe !== safe || previousRemit.roleKey !== roleKey) return undefined;
  try {
    const raw = JSON.parse(
      readFileSync(join(REPO, "ops", "remits", `${network.name}.json`), "utf8"),
    ) as { limits?: unknown };
    const parsed = limitsSchema.safeParse(raw.limits);
    // Only limits the previous Remit actually bound. A document whose hash does not match
    // is not what that Remit permitted, and comparing against it would report a widening
    // or a narrowing that never happened.
    return parsed.success && limitsHash(parsed.data) === previousRemit.limitsHash
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
})();

const widened = previousLimits === undefined ? [] : widenings(previousLimits, limits);
if (widened.length > 0) {
  say("");
  say("WIDENS AUTHORITY — this Remit permits more than the one it replaces:");
  for (const line of widened) say(`  ${line}`);
  say("");
  if (!args.flags.has("yes")) {
    logEvent("remit.issue.refused", {
      network: network.name,
      code: "REMIT_WOULD_WIDEN",
      widenings: widened,
    });
    fail(
      "re-run with --yes once you have read every line above. Narrowing needs no flag; " +
        "widening is the operator granting the agent more than it had, and the caps " +
        "that bound the money live in this document rather than in the preset.",
    );
  }
  say("--yes: widened on an operator's explicit judgement");
}

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
  nonce: nextNonce(),
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

/**
 * Two cap combinations that are legal, coherent as documents, and not what an operator
 * typing them usually means. Said out loud rather than refused: both are things somebody
 * may want, and a command that argues with a deliberate choice teaches people to stop
 * reading it.
 *
 * The first matters most. `requireReviewAboveUsd` is not a flag here, so lowering
 * `--per-tx` beneath it makes *every* action this Remit can authorise fall below the
 * review threshold — G3 stops existing for the life of the document, and nothing else
 * would ever say so. That is the same shape as the bug this project has already fixed
 * twice: a human gate removed by a flag rather than by a decision.
 */
const perTx = usdToMicros(limits.perTxCapUsd);
const daily = usdToMicros(limits.dailyCapUsd);
const reviewAbove = usdToMicros(limits.requireReviewAboveUsd);

if (perTx <= reviewAbove) {
  say("");
  say(
    `NOTE         no action under this Remit can reach G3. The review threshold is ` +
      `${limits.requireReviewAboveUsd} USD and the per-transaction cap is ` +
      `${limits.perTxCapUsd} USD, so nothing it authorises is above the threshold — ` +
      "every action runs unattended. That is a real choice at these sizes; it is " +
      "printed because nothing else would say it.",
  );
}

if (perTx > daily) {
  say("");
  say(
    `NOTE         the per-transaction cap (${limits.perTxCapUsd} USD) is larger than ` +
      `the whole day (${limits.dailyCapUsd} USD), so the daily cap is the only one that ` +
      "ever binds.",
  );
}
say(`written      ${relative(REPO, outPath)}`);
say("");
say("canonical limits bytes, which anyone can re-hash:");
say(`  ${canonicalJson(limits)}`);

// The sequence, written where rolling back the Remit file cannot reach it.
writeDeployment({
  network: network.name,
  chainId: network.chainId,
  lastRemit: { safe, roleKey, nonce: remit.nonce },
  updatedAt: new Date().toISOString(),
});

logEvent("remit.issued", {
  remitHash,
  network: network.name,
  nonce: remit.nonce,
  file: relative(REPO, outPath),
  ...(widened.length === 0 ? {} : { widened }),
});
