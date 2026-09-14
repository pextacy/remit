/**
 * An intent, through the gates, to the chain.
 *
 *   pnpm --filter ops propose --network anvil --kind supply   --amount 5
 *   pnpm --filter ops propose --network anvil --kind withdraw --amount 2 --to 0x…
 *
 * The first two gates, in order, over the issued Remit:
 *
 *   G1  the envelope — pure, free, and before any I/O. A refusal here costs one function
 *       call and tells the operator which field of which document was violated.
 *   G2  the preflight — one `eth_call`, no gas. A refusal here is a named Status from the
 *       Roles Modifier.
 *   G4  the chain. Only reached if both agreed.
 *
 * G3 is the human review, and lands with the console in P9; an action above the Remit's
 * review threshold says so here and proceeds, which is the one thing this script does
 * that the finished bridge will not.
 *
 * In P3 the last step stops being a direct send and becomes a KeeperHub workflow
 * invocation. The two gates in front of it do not change, which is the point of keeping
 * them here rather than in the script that happens to send.
 */

import { USDC_DECIMALS } from "@remit/core";
import { getAddress, parseUnits } from "viem";
import { AAVE_POOL_FOR } from "../lib/actions.js";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { fail, say } from "../lib/log.js";
import { runPipeline } from "../lib/pipeline.js";
import { loadRemit, RECEIPTS_ROOT, REVIEW_ROOT } from "../lib/remit-file.js";

const args = parseArgs();
const network = networkFrom(args);
const deployment = requireDeployment(network.name);
const rolesModifier = requireField(deployment, "rolesModifier");
const loaded = loadRemit(network.name);
const cast = await castFor(network);

const amount = parseUnits(option(args, "amount") ?? "1", USDC_DECIMALS).toString();
const kind = option(args, "kind") ?? "supply";
const counterpartyArg = option(args, "to") ?? option(args, "spender");

/**
 * The sensible default differs by kind, and getting it wrong is instructive: value goes
 * to the Safe, but an approval goes to the venue. They are different questions with
 * different allowlists, which is exactly why G1 checks them separately.
 */
const counterparty = getAddress(
  counterpartyArg ??
    (kind === "approve" ? AAVE_POOL_FOR(network.chainId) : loaded.remit.safe),
);

/**
 * The intent is assembled from typed arguments here, exactly as the Almanak adapter will
 * assemble it from a strategy action in P5. Nothing on this path can produce bytes.
 */
const intent =
  kind === "approve"
    ? { kind, asset: "USDC", amount, spender: counterparty }
    : kind === "supply"
      ? { kind, asset: "USDC", amount, onBehalfOf: counterparty }
      : kind === "withdraw"
        ? { kind, asset: "USDC", amount, to: counterparty }
        : fail("--kind must be approve, supply or withdraw");

say(
  `remit     ${loaded.remitHash.slice(0, 10)}… caps ${loaded.limits.perTxCapUsd}/${loaded.limits.dailyCapUsd} USD`,
);
say(`intent    ${JSON.stringify(intent)}`);
say("");

const result = await runPipeline({
  network,
  remit: loaded.remit,
  remitHash: loaded.remitHash,
  limits: loaded.limits,
  rolesModifier,
  agent: cast.agent,
  intent,
  receiptsRoot: RECEIPTS_ROOT,
  // G3 only exists when somebody is watching. `--review` turns it on and points it at
  // the queue the console reads; without it the receipt records that nobody looked.
  ...(args.flags.has("review") ? { reviewDir: REVIEW_ROOT } : {}),
  ...(option(args, "review-timeout") === undefined
    ? {}
    : { reviewTimeoutSeconds: Number(option(args, "review-timeout")) }),
});

if (result.stage === "g1") {
  say("");
  say("No network call was made. The refusal cost one function call and no gas.");
  process.exit(2);
}
if (result.stage === "g3") {
  say("");
  say("A human said no, or nobody said anything. Nothing was sent.");
  process.exit(4);
}
if (result.stage === "g2") {
  say("");
  say("One eth_call, no gas. The operator has the reason before anything is spent.");
  process.exit(3);
}
process.exit(result.ok ? 0 : 4);
