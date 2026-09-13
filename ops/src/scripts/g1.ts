/**
 * G1, run against the issued Remit, on every refusal it knows how to make.
 *
 *   pnpm --filter ops g1 --network anvil
 *
 * Not a test suite — it is the gate itself, driven over a table of intents, printing the
 * typed error each one produces. It exists because "the envelope check rejects bad
 * intents" is a claim, and a reviewer reading fourteen named refusals with the failing
 * field in each is evidence. It is also the material for the injection demo in P8.
 *
 * Nothing here touches a network. G1 is a pure function of (remit, limits, intent, now,
 * ledger), which is the property that lets the same call be re-run over a committed
 * receipt months later and produce the same answer.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE,
  checkEnvelope,
  type EnvelopeErrorCode,
  formatEnvelopeError,
  type LedgerEntry,
  type Limits,
  limitsHash,
  limitsSchema,
  type Remit,
  remitSchema,
} from "@remit/core";
import { type Address, getAddress } from "viem";
import { networkFrom, parseArgs } from "../lib/args.js";
import { fail, logEvent, say } from "../lib/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const args = parseArgs();
const network = networkFrom(args);

const bundlePath = join(REPO, "ops", "remits", `${network.name}.json`);
let parsedFile: { remit: unknown; limits: unknown };
try {
  parsedFile = JSON.parse(readFileSync(bundlePath, "utf8")) as typeof parsedFile;
} catch {
  fail(`no Remit at ops/remits/${network.name}.json — run remit:issue first`);
}

const remit = remitSchema.parse(parsedFile.remit);
const limits = limitsSchema.parse(parsedFile.limits);
const safe = remit.safe;
/** Somewhere funds must never be able to go. Any address that is not the Safe will do. */
const attacker: Address = getAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
const now = remit.notBefore + 60;

/** A Remit over a different limits document, for the cases that need narrower authority. */
function remitOver(narrowed: Limits): Remit {
  return { ...remit, limitsHash: limitsHash(narrowed) };
}

function ledgerOf(entries: readonly Partial<LedgerEntry>[]): readonly LedgerEntry[] {
  return entries.map((entry) => ({
    at: entry.at ?? now - 60,
    usdMicros: entry.usdMicros ?? "1000000",
    kind: entry.kind ?? "supply",
  }));
}

const usdc = { asset: "USDC" as const };
const FIVE = "5000000";

type Case = {
  readonly name: string;
  readonly intent: unknown;
  readonly expect: "pass" | EnvelopeErrorCode;
  readonly remit?: Remit;
  readonly limits?: Limits;
  readonly now?: number;
  readonly chainId?: 8453 | 84_532;
  readonly ledger?: readonly LedgerEntry[];
};

const cases: readonly Case[] = [
  // ---- inside the remit ----------------------------------------------------
  {
    name: "supply 5 USDC to the Safe",
    intent: { kind: "supply", ...usdc, amount: FIVE, onBehalfOf: safe },
    expect: "pass",
  },
  {
    name: "supply 0.50 USDC — below the review threshold",
    intent: { kind: "supply", ...usdc, amount: "500000", onBehalfOf: safe },
    expect: "pass",
  },
  {
    name: "withdraw 2 USDC back to the Safe",
    intent: { kind: "withdraw", ...usdc, amount: "2000000", to: safe },
    expect: "pass",
  },

  // ---- the intent is not an intent ----------------------------------------
  {
    name: "an intent carrying raw calldata",
    // The injection shape: a strategy field that becomes bytes. `.strict()` on the schema
    // means an unknown key is a rejection, not a field that gets quietly ignored.
    intent: {
      kind: "supply",
      ...usdc,
      amount: FIVE,
      onBehalfOf: safe,
      data: "0xa9059cbb000000000000000000000000dead",
    },
    expect: "INTENT_MALFORMED",
  },
  {
    name: "an asset named by address instead of symbol",
    intent: {
      kind: "supply",
      asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      amount: FIVE,
      onBehalfOf: safe,
    },
    expect: "INTENT_MALFORMED",
  },
  {
    name: "an amount as a float",
    intent: { kind: "supply", ...usdc, amount: 5.5, onBehalfOf: safe },
    expect: "INTENT_MALFORMED",
  },

  // ---- inside the schema, outside the remit --------------------------------
  {
    name: "withdraw to an attacker",
    intent: { kind: "withdraw", ...usdc, amount: "1000000", to: attacker },
    expect: "OUT_OF_REMIT_RECIPIENT",
  },
  {
    name: "supply credited to an attacker",
    intent: { kind: "supply", ...usdc, amount: "1000000", onBehalfOf: attacker },
    expect: "OUT_OF_REMIT_RECIPIENT",
  },
  {
    name: "approve an attacker to spend the Safe's USDC",
    intent: { kind: "approve", ...usdc, amount: FIVE, spender: attacker },
    expect: "OUT_OF_REMIT_SPENDER",
  },
  {
    name: "a kind the Remit does not grant",
    intent: { kind: "withdraw", ...usdc, amount: "1000000", to: safe },
    expect: "OUT_OF_REMIT_KIND",
    limits: { ...limits, allowedIntentKinds: ["approve", "supply"] },
  },
  {
    name: "a venue the Remit does not list",
    intent: { kind: "supply", ...usdc, amount: "1000000", onBehalfOf: safe },
    expect: "OUT_OF_REMIT_TARGET",
    limits: { ...limits, allowedTargets: [limits.allowedTargets[0] as Address] },
  },
  {
    name: "a function the Remit does not list",
    intent: { kind: "supply", ...usdc, amount: "1000000", onBehalfOf: safe },
    expect: "OUT_OF_REMIT_SELECTOR",
    limits: { ...limits, allowedSelectors: ["approve(address,uint256)"] },
  },

  // ---- inside the remit in kind, outside it in size ------------------------
  {
    name: "supply 6 USDC against a 5 USDC per-transaction cap",
    intent: { kind: "supply", ...usdc, amount: "6000000", onBehalfOf: safe },
    expect: "REMIT_CAP_EXCEEDED_PER_TX",
  },
  {
    name: "supply 5 USDC with 25 already spent today",
    intent: { kind: "supply", ...usdc, amount: FIVE, onBehalfOf: safe },
    expect: "REMIT_CAP_EXCEEDED_DAILY",
    ledger: ledgerOf([
      { usdMicros: "5000000" },
      { usdMicros: "5000000" },
      { usdMicros: "5000000" },
      { usdMicros: "5000000" },
      { usdMicros: "5000000" },
    ]),
  },
  {
    name: "the seventh action in an hour, against a limit of six",
    intent: { kind: "supply", ...usdc, amount: "100000", onBehalfOf: safe },
    expect: "REMIT_RATE_LIMIT_EXCEEDED",
    ledger: ledgerOf(
      Array.from({ length: 6 }, () => ({
        usdMicros: "100000",
        kind: "approve" as const,
      })),
    ),
  },

  // ---- the Remit itself is not in force -----------------------------------
  {
    name: "an hour before the Remit begins",
    intent: { kind: "supply", ...usdc, amount: FIVE, onBehalfOf: safe },
    expect: "REMIT_NOT_YET_VALID",
    now: remit.notBefore - 3600,
  },
  {
    name: "a day after the Remit expires",
    intent: { kind: "supply", ...usdc, amount: FIVE, onBehalfOf: safe },
    expect: "REMIT_EXPIRED",
    now: remit.notAfter + 86_400,
  },
  {
    name: "a testnet Remit used against mainnet",
    intent: { kind: "supply", ...usdc, amount: FIVE, onBehalfOf: safe },
    expect: "REMIT_CHAIN_MISMATCH",
    chainId: remit.chainId === BASE ? 84_532 : BASE,
  },

  // ---- the limits document was edited after the Remit was issued ----------
  {
    name: "limits widened to allow the attacker, hash left alone",
    intent: { kind: "withdraw", ...usdc, amount: "1000000", to: attacker },
    expect: "REMIT_LIMITS_MISMATCH",
    limits: { ...limits, allowedRecipients: [safe, attacker] },
  },
];

let failures = 0;
say(`remit     ${bundlePath.replace(`${REPO}/`, "")}`);
say(
  `caps      ${limits.perTxCapUsd} USD per tx, ${limits.dailyCapUsd} USD per day, ${limits.maxTxPerHour}/hour`,
);
say(`recipient ${limits.allowedRecipients.join(", ")}`);
say("");

for (const testCase of cases) {
  // A case that narrows the limits gets a Remit issued over *those* limits, so the only
  // thing under examination is the rule being demonstrated. The one exception is the
  // tamper case, which deliberately leaves the original hash in place.
  const caseLimits = testCase.limits ?? limits;
  const caseRemit =
    testCase.remit ??
    (testCase.limits !== undefined && testCase.expect !== "REMIT_LIMITS_MISMATCH"
      ? remitOver(caseLimits)
      : remit);

  const result = checkEnvelope({
    remit: caseRemit,
    limits: caseLimits,
    chainId: testCase.chainId ?? remit.chainId,
    intent: testCase.intent,
    now: testCase.now ?? now,
    ledger: testCase.ledger ?? [],
  });

  const got = result.ok ? "pass" : result.error.code;
  const matched = got === testCase.expect;
  if (!matched) failures += 1;

  const detail = result.ok
    ? `${result.decision.usd} USD${result.decision.requiresReview ? ", review required at G3" : ""}, headroom ${Number(result.decision.headroomMicros) / 1e6} USD`
    : formatEnvelopeError(result.error);

  say(`${matched ? "ok  " : "FAIL"} ${testCase.name}`);
  say(`     ${detail}`);

  logEvent("g1.case", {
    name: testCase.name,
    expected: testCase.expect,
    got,
    matched,
    detail,
  });
}

say("");
say(
  failures === 0
    ? `${cases.length} intents, ${cases.length} expected outcomes — G1 refuses what it claims to, and says why`
    : `${failures} of ${cases.length} cases did not behave as documented`,
);
process.exit(failures === 0 ? 0 : 1);
