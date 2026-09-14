/**
 * Put USDC and ETH in the Safe — fork only.
 *
 *   pnpm --filter ops fund --network anvil --usdc 100
 *
 * The USDC is minted by the token's own owner, impersonated on the fork. That is the
 * token's real minting authority over real forked state, not a balance we wrote into a
 * storage slot and not a fixture pretending to be one (CLAUDE.md §2.1).
 *
 * On Base Sepolia, use the Aave faucet for the same token and fund the Safe by hand; on
 * mainnet, send real USDC. Neither is this script's business.
 */

import { AAVE_V3_A_USDC, erc20Abi, USDC, USDC_DECIMALS } from "@remit/core";
import { encodeFunctionData, formatUnits, getAddress, parseUnits } from "viem";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { impersonate, publicClientFor, send, sendTx } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";

const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const TOKEN_OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const args = parseArgs();
const network = networkFrom(args);

if (!network.canImpersonate) {
  fail("fund only runs against a fork — on a real network, use the faucet or send USDC");
}

const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const client = publicClientFor(network);
const usdc = getAddress(USDC[network.chainId]);
const amount = parseUnits(option(args, "usdc") ?? "100", USDC_DECIMALS);

/**
 * Two chains, two ways to get USDC onto a forked Safe.
 *
 * On Base Sepolia the Aave-listed token is a test token whose `owner` can mint, so the
 * token's own minting authority is used. On Base mainnet, Circle's USDC has an `owner`
 * but minting needs a configured minter with an allowance — so that attempt is allowed
 * to revert, and the Safe is funded instead by impersonating a contract that really does
 * hold millions of real USDC and transferring some.
 *
 * Both are forked real state, moved by its real holder. Neither is a balance written
 * into a storage slot (CLAUDE.md §2.1).
 */
async function fundFromMinter(): Promise<boolean> {
  let tokenOwner: `0x${string}`;
  try {
    tokenOwner = (await client.readContract({
      address: usdc,
      abi: TOKEN_OWNER_ABI,
      functionName: "owner",
    })) as `0x${string}`;
  } catch {
    return false;
  }

  const minter = await impersonate(network, tokenOwner);
  const result = await sendTx(
    network,
    minter,
    {
      to: usdc,
      data: encodeFunctionData({
        abi: TOKEN_OWNER_ABI,
        functionName: "mint",
        args: [safe, amount],
      }),
    },
    "usdc.mint",
    { gas: 200_000n, allowRevert: true },
  );

  return result.status === "success";
}

async function fundFromHolder(): Promise<void> {
  const holder = getAddress(AAVE_V3_A_USDC[network.chainId]);
  const held = (await client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint;

  if (held < amount) {
    fail(`${holder} holds ${formatUnits(held, USDC_DECIMALS)} USDC — not enough to fund`);
  }

  const whale = await impersonate(network, holder);
  await send(
    network,
    whale,
    {
      to: usdc,
      data: encodeFunctionData({
        abi: TRANSFER_ABI,
        functionName: "transfer",
        args: [safe, amount],
      }),
    },
    "usdc.transfer",
  );
}

if (!(await fundFromMinter())) {
  say("the token has no usable mint here — funding from a real holder instead");
  await fundFromHolder();
}

await client.request({
  method: "anvil_setBalance" as never,
  params: [safe, `0x${(10n ** 18n).toString(16)}`] as never,
});

const balance = (await client.readContract({
  address: usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [safe],
})) as bigint;

say(`safe ${safe} holds ${formatUnits(balance, USDC_DECIMALS)} USDC`);
logEvent("safe.funded", { safe, usdc, balance: balance.toString() });
