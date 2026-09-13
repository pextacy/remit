/**
 * PLAN.md 1.1 — deploy a 2-of-3 Safe.
 *
 *   pnpm --filter ops safe:deploy --network anvil
 */
import { keccak256, toHex } from "viem";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { explorerAddress } from "../lib/clients.js";
import { writeDeployment } from "../lib/deployment.js";
import { logEvent, say } from "../lib/log.js";
import { deploySafe } from "../lib/safe.js";

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);

// Deterministic per label, so a re-run finds the same Safe instead of making another.
const salt = BigInt(keccak256(toHex(option(args, "salt") ?? "remit-p1")));

const { safe, txHash } = await deploySafe(network, cast.deployer, {
  owners: cast.ownerAddresses,
  threshold: 2,
  saltNonce: salt,
});

writeDeployment({
  network: network.name,
  chainId: network.chainId,
  safe,
  owners: cast.ownerAddresses,
  threshold: 2,
  updatedAt: new Date().toISOString(),
});

say(`safe ${safe}  ${explorerAddress(network.chainId, safe)}`);
logEvent("p1.1.done", { safe, txHash });
