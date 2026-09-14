/**
 * RM-5 — sign the issued Remit as a Safe owner.
 *
 *   pnpm --filter ops remit:sign --network anvil
 *
 * `eth_signTypedData_v4` over the Remit's EIP-712 struct, from each owner this machine can
 * sign for. On a fork that is anvil's unlocked accounts; on a real network it is the keys
 * in the environment, and the cold third owner signs somewhere else and hands the
 * signature over.
 *
 * Nothing on chain checks these. What they buy is attribution: without them a Remit is a
 * file anyone with write access could have produced, and the hashes only prove it has not
 * changed since. `remit serve` verifies them against the Safe's *current* owners before it
 * accepts a single intent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remitTypedData, safeAbi, verifyRemitSignatures } from "@remit/core";
import { createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { castFor } from "../lib/actors.js";
import { networkFrom, parseArgs } from "../lib/args.js";
import { chainFor, publicClientFor } from "../lib/clients.js";
import { fail, logEvent, say } from "../lib/log.js";
import { loadRemit, REPO } from "../lib/remit-file.js";

const args = parseArgs();
const network = networkFrom(args);
const loaded = loadRemit(network.name);
const cast = await castFor(network);
const client = publicClientFor(network);

const owners = (await client.readContract({
  address: loaded.remit.safe,
  abi: safeAbi,
  functionName: "getOwners",
})) as readonly `0x${string}`[];
const threshold = Number(
  (await client.readContract({
    address: loaded.remit.safe,
    abi: safeAbi,
    functionName: "getThreshold",
  })) as bigint,
);

say(`safe      ${loaded.remit.safe}  ${threshold}-of-${owners.length}`);
say(`remit     ${loaded.remitHash}`);
say("");

const wallet = createWalletClient({
  chain: chainFor(network),
  transport: http(network.rpcUrl),
});
const typedData = remitTypedData(loaded.remit);
const signatures: Hex[] = [];

for (const owner of cast.owners) {
  try {
    const signature =
      owner.kind === "local"
        ? await wallet.signTypedData({
            account: privateKeyToAccount(owner.privateKey),
            ...typedData,
          })
        : // A fork's unlocked account signs through the node, so no key exists anywhere
          // in this process — the same property the rest of the ops tooling has.
          await wallet.signTypedData({ account: owner.address, ...typedData });

    signatures.push(signature);
    say(`signed    ${owner.address}`);
  } catch (error) {
    say(`skipped   ${owner.address} — ${String(error).split("\n")[0]}`);
  }
}

if (signatures.length === 0) fail("no owner on this machine could sign");

const check = await verifyRemitSignatures({
  remit: loaded.remit,
  signatures,
  owners: [...owners],
  threshold,
});

say("");
say(`${check.ok ? "ok" : "NOT ENOUGH"}   ${check.reason}`);

const path = join(REPO, "ops", "remits", `${network.name}.json`);
const bundle = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
bundle.signatures = signatures;
writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);

say(`written   ops/remits/${network.name}.json`);
logEvent("remit.signed", {
  remitHash: loaded.remitHash,
  signatures: signatures.length,
  valid: check.valid.length,
  threshold,
  ok: check.ok,
});

// Below threshold is not a failure to record — it is a Remit waiting for another owner,
// which is the normal state of a 2-of-3 until the second person signs.
process.exit(check.ok ? 0 : 2);
