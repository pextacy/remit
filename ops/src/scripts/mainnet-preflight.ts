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
  AAVE_V3_POOL_ADDRESSES_PROVIDER,
  aavePoolAbi,
  BASE_SEPOLIA,
  buildPreset,
  CIRCLE_TESTNET_USDC_BASE_SEPOLIA,
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

  // Not `?? "0x"`. Every check below feeds these to `getAddress`, which throws on a
  // placeholder — so a deployment missing its role or its agent took the whole preflight
  // down with a viem stack trace, at exactly the moment somebody was trying to find out
  // what was missing. A precondition that is absent is a precondition that failed.
  if (deployment.roleKey === undefined || deployment.agentSigner === undefined) {
    record(
      "deployment",
      false,
      `safe ${safe}, roles ${rolesModifier} — but ` +
        [
          deployment.roleKey === undefined ? "no roleKey" : undefined,
          deployment.agentSigner === undefined ? "no agentSigner" : undefined,
        ]
          .filter((missing) => missing !== undefined)
          .join(" and ") +
        ": run roles:apply and role:assign",
    );
    return;
  }
  const roleKey = deployment.roleKey;
  const agent = getAddress(deployment.agentSigner);

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

  // And nobody else. A second member holds the identical preset, is named by no Remit
  // and no receipt, and is revoked by nothing — `kill` acts on the agent this deployment
  // recorded, so pulling it reports success while the other address keeps the authority.
  const extraMembers = [...onChain.members.entries()]
    .filter(([member, isMember]) => isMember && member !== getAddress(agent))
    .map(([member]) => member);
  record(
    "nobody else is in the role",
    extraMembers.length === 0,
    extraMembers.length === 0
      ? "the agent is the only member"
      : `${extraMembers.join(", ")} — each holds this preset in full, and the kill ` +
          "switch revokes none of them",
  );

  // ---- 4. can it actually pay? ------------------------------------------
  const usdc = getAddress(USDC[network.chainId]);
  const safeUsdc = (await client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [safe],
  })) as bigint;

  const perTx = usdToMicros(loaded.limits.perTxCapUsd);

  /**
   * Short on USDC — but is there a lookalike sitting in the Safe?
   *
   * Aave's Base Sepolia market lists one USDC and Circle's faucet hands out another, and
   * the two are indistinguishable from the outside: same symbol, same decimals. Funding
   * from the wrong faucet therefore looks exactly like funding from the right one, and
   * the first sign of it is a `supply` that reverts inside Aave for a reason an operator
   * reads as a preset failure.
   *
   * It cost a round trip here on 2026-09-15, which is what a documented trap does until
   * something checks for it. Only asked when the balance is short, and only on the chain
   * where the pair exists.
   */
  let usdcDetail = `${formatUnits(safeUsdc, USDC_DECIMALS)} USDC (one capped action needs ${loaded.limits.perTxCapUsd})`;
  if (safeUsdc < perTx && network.chainId === BASE_SEPOLIA) {
    const lookalike = (await client
      .readContract({
        address: getAddress(CIRCLE_TESTNET_USDC_BASE_SEPOLIA),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [safe],
      })
      .catch(() => 0n)) as bigint;

    if (lookalike > 0n) {
      usdcDetail +=
        ` — but the Safe holds ${formatUnits(lookalike, USDC_DECIMALS)} of ` +
        `${CIRCLE_TESTNET_USDC_BASE_SEPOLIA}, which is Circle's testnet USDC. Aave's ` +
        "Base Sepolia market does not list it, so it cannot be supplied. Use " +
        "https://app.aave.com/faucet for the token this build uses.";
    }
  }

  record("safe holds USDC", safeUsdc >= perTx, usdcDetail);

  // Gas is paid by whoever broadcasts. On the product path that is KeeperHub's signer,
  // not us — but on the ops path it is the agent EOA, and an agent with no ETH is a
  // demo that fails in front of an audience.
  const agentEth = await client.getBalance({ address: getAddress(agent) });
  record(
    "agent has gas",
    agentEth > 0n,
    `${formatEther(agentEth)} ETH (only needed on the ops-direct path; KeeperHub pays on its own)`,
  );

  /**
   * Is the venue the contract we think it is?
   *
   * This used to read the pool's USDC balance and assert `>= 0n`, which is true of every
   * uint256 ever returned — including the zero a call to an address with no code produces.
   * A check that cannot fail is worse than no check: it reports "ok" beside every real
   * one, and a reader counts it.
   *
   * `ADDRESSES_PROVIDER()` is the probe `verify:constants` uses, for the same reason: it
   * is a function only the pool has, and its answer is in the address book this
   * repository pinned. A wrong pool address answers nothing.
   */
  const pool = getAddress(AAVE_V3_POOL[network.chainId]);
  const expectedProvider = getAddress(AAVE_V3_POOL_ADDRESSES_PROVIDER[network.chainId]);
  let venue = "the pool did not answer ADDRESSES_PROVIDER()";
  let venueOk = false;
  try {
    const provider = (await client.readContract({
      address: pool,
      abi: aavePoolAbi,
      functionName: "ADDRESSES_PROVIDER",
    })) as `0x${string}`;
    venueOk = getAddress(provider) === expectedProvider;
    venue = venueOk
      ? `Aave v3 pool ${pool}, provider ${provider}`
      : `${pool} points at provider ${provider}, not ${expectedProvider}`;
  } catch (error) {
    venue = `${pool}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  record("venue is the verified pool", venueOk, venue);

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
      : "KEEPERHUB_API_KEY is not set — the product path cannot submit",
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
