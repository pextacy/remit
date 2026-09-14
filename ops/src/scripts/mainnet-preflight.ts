/**
 * Everything that has to be true before the mainnet transaction, checked in one place.
 *
 *   pnpm --filter ops mainnet:preflight --network base
 *   pnpm --filter ops mainnet:preflight --network anvil-base   # the rehearsal
 *
 * P6's whole job is to secure the submission requirement early, and the way that goes
 * wrong is not a dramatic failure — it is discovering at 23:00 on Thursday that the Safe
 * has no USDC, or that the agent EOA has no ETH for gas, or that the Remit was issued
 * against a preset nobody applied. Each of those is a minute to check and an hour to fix.
 *
 * Reads only. It cannot change anything, so it is safe to run against mainnet without a
 * flag, and it should be run before every attempt rather than once.
 */

import { join } from "node:path";
import {
  AAVE_V3_POOL,
  buildPreset,
  checkPresetDrift,
  diffRole,
  erc20Abi,
  readRole,
  safeAbi,
  USDC,
  USDC_DECIMALS,
  usdToMicros,
  verifyChainAt,
} from "@remit/core";
import { formatEther, formatUnits, getAddress } from "viem";
import { castFor } from "../lib/actors.js";
import { networkFrom, parseArgs } from "../lib/args.js";
import { explorerAddress, publicClientFor } from "../lib/clients.js";
import { readDeployment } from "../lib/deployment.js";
import { readLedger } from "../lib/ledger-store.js";
import { logEvent, say } from "../lib/log.js";
import { loadRemit, RECEIPTS_ROOT } from "../lib/remit-file.js";

const args = parseArgs();
const network = networkFrom(args, { readOnly: true });
const client = publicClientFor(network);

type Check = { readonly label: string; readonly ok: boolean; readonly detail: string };
const checks: Check[] = [];

function record(label: string, ok: boolean, detail: string): void {
  checks.push({ label, ok, detail });
}

async function run(): Promise<void> {
  // ---- 1. is there a deployment at all? ---------------------------------
  const deployment = readDeployment(network.name);
  if (deployment?.safe === undefined || deployment.rolesModifier === undefined) {
    record("deployment", false, `no Safe or Roles instance for ${network.name}`);
    return;
  }
  const safe = deployment.safe;
  const rolesModifier = deployment.rolesModifier;
  const roleKey = deployment.roleKey ?? "0x";
  const agent = deployment.agentSigner ?? "0x";

  record("deployment", true, `safe ${safe}, roles ${rolesModifier}`);

  // ---- 2. is the Safe what we think it is? ------------------------------
  const [owners, threshold, moduleEnabled] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: "isModuleEnabled",
      args: [rolesModifier],
    }),
  ]);
  const ownerList = owners as readonly string[];
  record(
    "safe owners",
    ownerList.length >= 2 && Number(threshold) >= 2,
    `${Number(threshold)}-of-${ownerList.length}`,
  );
  record("roles module", moduleEnabled as boolean, "enabled on the Safe");

  // The agent must not be an owner. If it is, every gate below is decoration: the key
  // that proposes can also rewrite what it is allowed to propose.
  const agentIsOwner = ownerList.some((owner) => getAddress(owner) === getAddress(agent));
  record("agent is not an owner", !agentIsOwner, agent);

  // ---- 3. the Remit, and whether the chain agrees with it ---------------
  const loaded = loadRemit(network.name);
  record("remit", true, loaded.remitHash);
  record(
    "caps",
    loaded.limits.perTxCapUsd === "5" && loaded.limits.dailyCapUsd === "25",
    `${loaded.limits.perTxCapUsd} USD per tx, ${loaded.limits.dailyCapUsd} USD per day`,
  );

  const drift = await checkPresetDrift({
    client,
    chainId: network.chainId,
    remit: loaded.remit,
    limits: loaded.limits,
    rolesModifier,
    agent: getAddress(agent),
    ...(deployment.rolesDeployedBlock === undefined
      ? {}
      : { fromBlock: BigInt(deployment.rolesDeployedBlock) }),
  });
  record(
    "preset agrees with the Remit",
    drift.ok,
    drift.ok
      ? `${drift.eventsReplayed} events replayed, no drift`
      : drift.findings.map((finding) => finding.code).join(", "),
  );

  const onChain = await readRole(client, rolesModifier, roleKey, {
    ...(deployment.rolesDeployedBlock === undefined
      ? {}
      : { fromBlock: BigInt(deployment.rolesDeployedBlock) }),
  });
  const deltas = diffRole(buildPreset(network.chainId, roleKey), onChain);
  record("preset applied", deltas.length === 0, `${deltas.length} difference(s)`);
  record("agent is in the role", onChain.members.get(getAddress(agent)) === true, agent);

  // ---- 4. can it actually pay? ------------------------------------------
  const usdc = getAddress(USDC[network.chainId]);
  const safeUsdc = (await client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [safe],
  })) as bigint;

  const perTx = usdToMicros(loaded.limits.perTxCapUsd);
  record(
    "safe holds USDC",
    safeUsdc >= perTx,
    `${formatUnits(safeUsdc, USDC_DECIMALS)} USDC (one capped action needs ${loaded.limits.perTxCapUsd})`,
  );

  // Gas is paid by whoever broadcasts. On the product path that is KeeperHub's signer,
  // not us — but on the ops path it is the agent EOA, and an agent with no ETH is a
  // demo that fails in front of an audience.
  const agentEth = await client.getBalance({ address: getAddress(agent) });
  record(
    "agent has gas",
    agentEth > 0n,
    `${formatEther(agentEth)} ETH (only needed on the ops-direct path; KeeperHub pays on its own)`,
  );

  const allowance = (await client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(AAVE_V3_POOL[network.chainId])],
  })) as bigint;
  record(
    "venue is live",
    allowance >= 0n,
    `Aave v3 pool ${AAVE_V3_POOL[network.chainId]}`,
  );

  // ---- 5. headroom and the receipt chain --------------------------------
  const spentToday = readLedger(network.name)
    .filter(
      (entry) =>
        entry.kind === "supply" && entry.at > Math.floor(Date.now() / 1000) - 86_400,
    )
    .reduce((total, entry) => total + BigInt(entry.usdMicros), 0n);
  record(
    "daily headroom",
    spentToday < usdToMicros(loaded.limits.dailyCapUsd),
    `${formatUnits(spentToday, USDC_DECIMALS)} of ${loaded.limits.dailyCapUsd} USD used today`,
  );

  try {
    const chain = verifyChainAt(join(RECEIPTS_ROOT, network.name), {
      remit: loaded.remit,
      limits: loaded.limits,
    });
    record(
      "receipt chain",
      chain.ok,
      chain.ok
        ? `${chain.count} receipt(s), head ${chain.head}`
        : `${chain.problems.length} problem(s)`,
    );
  } catch {
    record("receipt chain", true, "no receipts yet for this network");
  }

  // ---- 6. the thing that actually submits -------------------------------
  const hasKey = (process.env.KEEPERHUB_API_KEY ?? "") !== "";
  record(
    "keeperhub configured",
    hasKey,
    hasKey
      ? "KEEPERHUB_API_KEY is set"
      : "KEEPERHUB_API_KEY is not set — the product path cannot submit (OQ-1)",
  );

  const cast = await castFor(network);
  record(
    "agent signer available",
    cast.agent.address === getAddress(agent),
    cast.agent.address,
  );
}

await run();

say(`network   ${network.name} (chain ${network.chainId})`);
say("");
for (const check of checks) {
  say(`${check.ok ? "ok  " : "NO  "} ${check.label.padEnd(28)} ${check.detail}`);
}

const blocking = checks.filter((check) => !check.ok);
say("");
say(
  blocking.length === 0
    ? "ready: every precondition for the mainnet transaction holds"
    : `${blocking.length} precondition(s) not met — fix these before spending anything`,
);
for (const check of blocking) say(`  - ${check.label}: ${check.detail}`);

const safeAddress = readDeployment(network.name)?.safe;
if (safeAddress !== undefined) {
  say("");
  say(`safe on the explorer: ${explorerAddress(network.chainId, safeAddress)}`);
}

logEvent("mainnet.preflight", {
  network: network.name,
  ready: blocking.length === 0,
  blocking: blocking.map((check) => check.label),
});

process.exit(blocking.length === 0 ? 0 : 1);
