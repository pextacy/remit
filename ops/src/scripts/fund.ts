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

import { erc20Abi, USDC, USDC_DECIMALS } from "@remit/core";
import { encodeFunctionData, formatUnits, getAddress, parseUnits } from "viem";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { impersonate, publicClientFor, send } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";

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

const tokenOwner = (await client.readContract({
  address: usdc,
  abi: TOKEN_OWNER_ABI,
  functionName: "owner",
})) as `0x${string}`;

const minter = await impersonate(network, tokenOwner);
await send(
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
);

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
