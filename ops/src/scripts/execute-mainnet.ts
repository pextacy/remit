/**
 * The mainnet path, and it is deliberately awkward (CLAUDE.md §2.4).
 *
 *   pnpm --filter ops exec:mainnet --network base --remit 0x… --kind supply --amount 5 --confirm
 *
 * Four things have to be true before anything is sent: the network is named explicitly,
 * `--confirm` is present, the Remit is named by hash and matches the one issued for this
 * deployment, and the operator has seen the decoded action — the Safe, the roleKey, the
 * value, the recipient — printed in front of them.
 *
 * None of that makes a mistake impossible. It makes a mistake require four separate acts
 * of intent, which is the most a script can honestly offer.
 *
 * It runs the same pipeline as `propose`. A mainnet path with its own copy of the gates
 * is a mainnet path nobody has rehearsed.
 */

import {
  checkPresetDrift,
  microsToUsd,
  USDC,
  USDC_DECIMALS,
  usdToMicros,
} from "@remit/core";
import { formatUnits, getAddress, parseUnits } from "viem";
import { AAVE_POOL_FOR } from "../lib/actions.js";
import { castFor } from "../lib/actors.js";
import { networkFrom, numberOption, option, parseArgs } from "../lib/args.js";
import { publicClientFor } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { readLedger } from "../lib/ledger-store.js";
import { fail, logEvent, say } from "../lib/log.js";
import { runPipeline } from "../lib/pipeline.js";
import {
  loadRemit,
  RECEIPTS_ROOT,
  REVIEW_ROOT,
  requireRemitHash,
} from "../lib/remit-file.js";

const args = parseArgs();
const network = networkFrom(args);

if (!args.flags.has("confirm")) {
  fail(
    "exec:mainnet always requires --confirm, on every network. Rehearse it as it runs.",
  );
}

const deployment = requireDeployment(network.name);
const rolesModifier = requireField(deployment, "rolesModifier");
const loaded = loadRemit(network.name);
requireRemitHash(loaded, option(args, "remit"));

const cast = await castFor(network);

/**
 * RM-4, on the path that spends real money.
 *
 * `mainnet:preflight` prints this and an operator is told to run it first — which means
 * the check that the chain still says what the Remit says was advisory on the one command
 * where it is not. A preset that has drifted makes every line of the preamble below a
 * promise nobody is keeping: the Remit would state a recipient allowlist the chain had
 * stopped enforcing, and G1 would agree with it all the way to G4.
 *
 * So it runs here, before the operator is shown anything, and a difference stops the
 * command. `--ignore-drift` exists because an operator mid-migration may know exactly
 * which difference they are looking at — and it makes them say so.
 */
const drift = await checkPresetDrift({
  client: publicClientFor(network),
  chainId: network.chainId,
  remit: loaded.remit,
  limits: loaded.limits,
  rolesModifier,
  agent: cast.agent.address,
  ...(deployment.rolesDeployedBlock === undefined
    ? {}
    : { fromBlock: BigInt(deployment.rolesDeployedBlock) }),
  ...(loaded.signatures.length === 0 ? {} : { signatures: loaded.signatures }),
});

if (!drift.ok) {
  for (const finding of drift.findings) {
    say(`DRIFT     ${finding.code}: ${finding.detail}`);
  }
  logEvent("exec.mainnet.drift", {
    network: network.name,
    findings: drift.findings.map((finding) => finding.code),
  });

  if (!args.flags.has("ignore-drift")) {
    fail(
      "the Remit and the chain disagree — nothing was sent. Fix the preset with " +
        "roles:diff and roles:apply, or reissue the Remit. Do not widen either to make " +
        "this pass. If you know exactly which difference this is, --ignore-drift.",
    );
  }
  say("--ignore-drift: proceeding against an operator's explicit judgement");
}

say(
  `preset    ${drift.eventsReplayed} event(s) replayed as of block ${drift.asOfBlock}` +
    `${drift.ok ? " — the chain says what the Remit says" : ""}`,
);
say(
  loaded.signatures.length === 0
    ? "signed    no — the Remit is unsigned; the preset is still the authority"
    : `signed    ${loaded.signatures.length} owner signature(s), checked against the Safe's current owners`,
);

const kind = option(args, "kind") ?? "supply";
/** Refused here rather than at G1, so the message names the flag the operator typed. */
const amountArg = option(args, "amount") ?? "1";
const amount = (() => {
  try {
    const parsed = parseUnits(amountArg, USDC_DECIMALS);
    if (parsed <= 0n) fail(`--amount must be greater than zero, not "${amountArg}"`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("--amount")) throw error;
    return fail(`--amount "${amountArg}" is not a decimal amount of USDC — nothing sent`);
  }
})();
const counterparty =
  option(args, "to") ??
  (kind === "approve" ? AAVE_POOL_FOR(network.chainId) : loaded.remit.safe);

const intent =
  kind === "approve"
    ? {
        kind,
        asset: "USDC",
        amount: amount.toString(),
        spender: getAddress(counterparty),
      }
    : kind === "supply"
      ? {
          kind,
          asset: "USDC",
          amount: amount.toString(),
          onBehalfOf: getAddress(counterparty),
        }
      : kind === "withdraw"
        ? { kind, asset: "USDC", amount: amount.toString(), to: getAddress(counterparty) }
        : fail("--kind must be approve, supply or withdraw");

// ---- the preamble: what is about to happen, in full -----------------------
const spentToday = readLedger(network.name)
  .filter(
    (entry) =>
      entry.kind === "supply" && entry.at > Math.floor(Date.now() / 1000) - 86_400,
  )
  .reduce((total, entry) => total + BigInt(entry.usdMicros), 0n);

say("");
say("".padEnd(78, "="));
say(
  network.isMainnet
    ? "  BASE MAINNET — REAL FUNDS"
    : `  ${network.name} — rehearsal of the mainnet path`,
);
say("".padEnd(78, "="));
say(`  action      ${kind} ${formatUnits(amount, USDC_DECIMALS)} USDC`);
say(`  asset       ${getAddress(USDC[network.chainId])}`);
say(`  recipient   ${getAddress(counterparty)}`);
say(`  value       0 ETH (ExecutionOptions.None — the role cannot send native value)`);
say("");
say(`  safe        ${loaded.remit.safe}`);
say(`  roles       ${rolesModifier}`);
say(`  roleKey     ${loaded.remit.roleKey}`);
say(`  agent       ${cast.agent.address}`);
say("");
say(`  remit       ${loaded.remitHash}`);
say(
  `  caps        ${loaded.limits.perTxCapUsd} USD per tx, ${loaded.limits.dailyCapUsd} USD per day`,
);
say(`  spent today ${microsToUsd(spentToday)} USD of ${loaded.limits.dailyCapUsd}`);
say(
  `  headroom    ${microsToUsd(usdToMicros(loaded.limits.dailyCapUsd) - spentToday)} USD`,
);
say("".padEnd(78, "="));
say("");

logEvent("exec.mainnet.preamble", {
  network: network.name,
  kind,
  amount: amount.toString(),
  recipient: getAddress(counterparty),
  safe: loaded.remit.safe,
  roleKey: loaded.remit.roleKey,
  remitHash: loaded.remitHash,
});

const reviewTimeoutSeconds = numberOption(args, "review-timeout", {
  min: 1,
  max: 86_400,
});

const result = await runPipeline({
  network,
  remit: loaded.remit,
  remitHash: loaded.remitHash,
  limits: loaded.limits,
  rolesModifier,
  agent: cast.agent,
  intent,
  receiptsRoot: RECEIPTS_ROOT,
  // G3 is on. It used to need `--review`, which meant the human gate could be removed
  // by forgetting a flag — and the flag was easy to forget precisely on the runs where
  // it mattered. `--no-review` still exists, has to be typed, and puts "nobody looked"
  // in the receipt rather than quietly leaving G3 out of it.
  ...(args.flags.has("no-review")
    ? { whenUnreviewable: "proceed" as const }
    : {
        reviewDir: REVIEW_ROOT,
      }),
  // Refused where it was typed. A `NaN` timeout is no wait at all rather than a long
  // one, and G3 would then refuse instantly with nobody having had the chance to look.
  ...(reviewTimeoutSeconds === undefined ? {} : { reviewTimeoutSeconds }),
});

if (result.stage !== "g4") {
  process.exit(result.stage === "g1" ? 2 : result.stage === "g2" ? 3 : 4);
}
process.exit(result.ok ? 0 : 4);
