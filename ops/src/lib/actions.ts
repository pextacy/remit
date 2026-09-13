/**
 * The three actions the preset allows, and the two it does not.
 *
 * Note what is *not* here: no function takes a raw `to`, a raw selector, or an ABI string.
 * Callers choose a named action and fill typed parameters. That constraint is the whole
 * thesis of the project, and it is cheaper to keep than to retrofit (CLAUDE.md §2.3).
 */

import {
  AAVE_V3_POOL,
  aavePoolAbi,
  erc20Abi,
  type SupportedChainId,
  USDC,
  USDC_DECIMALS,
} from "@remit/core";
import { type Address, encodeFunctionData, formatUnits, getAddress } from "viem";
import type { RoleAction } from "./exec-role.js";

/**
 * `transfer` exists only so its refusal can be shown. It is deliberately not part of the
 * product's action vocabulary — nothing in `@remit/core` can reach for it.
 */
const ERC20_TRANSFER_ABI = [
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

function amountLabel(amount: bigint): string {
  return `${formatUnits(amount, USDC_DECIMALS)} USDC`;
}

export function approveAction(
  chainId: SupportedChainId,
  spender: Address,
  amount: bigint,
): RoleAction {
  const usdc = getAddress(USDC[chainId]);
  return {
    label: `USDC.approve(${spender}, ${amountLabel(amount)})`,
    target: usdc,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

export function supplyAction(
  chainId: SupportedChainId,
  onBehalfOf: Address,
  amount: bigint,
): RoleAction {
  const usdc = getAddress(USDC[chainId]);
  return {
    label: `Aave.supply(${amountLabel(amount)}, onBehalfOf=${onBehalfOf})`,
    target: getAddress(AAVE_V3_POOL[chainId]),
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "supply",
      args: [usdc, amount, onBehalfOf, 0],
    }),
  };
}

export function withdrawAction(
  chainId: SupportedChainId,
  to: Address,
  amount: bigint,
): RoleAction {
  const usdc = getAddress(USDC[chainId]);
  return {
    label: `Aave.withdraw(${amountLabel(amount)}, to=${to})`,
    target: getAddress(AAVE_V3_POOL[chainId]),
    data: encodeFunctionData({
      abi: aavePoolAbi,
      functionName: "withdraw",
      args: [usdc, amount, to],
    }),
  };
}

/** Out of preset by construction: a function on USDC that was never scoped. */
export function transferAction(
  chainId: SupportedChainId,
  to: Address,
  amount: bigint,
): RoleAction {
  return {
    label: `USDC.transfer(${to}, ${amountLabel(amount)})`,
    target: getAddress(USDC[chainId]),
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [to, amount],
    }),
  };
}

/** Send an otherwise-valid action somewhere the preset never cleared. */
export function redirect(action: RoleAction, target: Address): RoleAction {
  return {
    ...action,
    target: getAddress(target),
    label: `${action.label} — redirected to unscoped target ${getAddress(target)}`,
  };
}

export const AAVE_POOL_FOR = (chainId: SupportedChainId): Address =>
  getAddress(AAVE_V3_POOL[chainId]);
