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

import { microsToUsd, USDC, USDC_DECIMALS, usdToMicros } from "@remit/core";
import { formatUnits, getAddress, parseUnits } from "viem";
import { AAVE_POOL_FOR } from "../lib/actions.js";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { readLedger } from "../lib/ledger-store.js";
import { fail, logEvent, say } from "../lib/log.js";
import { runPipeline } from "../lib/pipeline.js";
import { loadRemit, RECEIPTS_ROOT, requireRemitHash } from "../lib/remit-file.js";

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
const kind = option(args, "kind") ?? "supply";
const amount = parseUnits(option(args, "amount") ?? "1", USDC_DECIMALS);
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

const result = await runPipeline({
  network,
  remit: loaded.remit,
  remitHash: loaded.remitHash,
  limits: loaded.limits,
  rolesModifier,
  agent: cast.agent,
  intent,
  receiptsRoot: RECEIPTS_ROOT,
});

if (result.stage !== "g4") process.exit(result.stage === "g1" ? 2 : 3);
process.exit(result.ok ? 0 : 4);
