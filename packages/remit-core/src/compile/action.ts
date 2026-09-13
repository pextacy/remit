/**
 * Intent → calldata. The only place in this repository where calldata is built.
 *
 * Every byte comes from an ABI that was verified against the chain and committed
 * (docs/VERIFIED.md), and every argument comes from a schema-validated intent. There is
 * no parameter here that a strategy can fill with an arbitrary address-and-selector pair,
 * which is what makes "the agent proposes, the chain enforces" mean something.
 *
 * The asset is a *symbol* in the intent and becomes an address here, from the verified
 * table. A strategy cannot name a token by address, so it cannot name a token we have not
 * checked.
 */
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  toFunctionSelector,
} from "viem";
import { aavePoolAbi } from "../chain/abi/aave-pool.js";
import { erc20Abi } from "../chain/abi/erc20.js";
import type { SupportedChainId } from "../chain/addresses.js";
import { AAVE_V3_POOL, USDC } from "../chain/addresses.js";
import { counterparty, type Intent } from "../schema/intent.js";
import type { AssetSymbol } from "../schema/primitives.js";

export type CompiledAction = {
  readonly kind: Intent["kind"];
  /** The contract the Roles Modifier will be asked to call. */
  readonly target: Address;
  readonly signature: string;
  readonly selector: Hex;
  readonly calldata: Hex;
  /** The address the intent names: recipient for supply/withdraw, spender for approve. */
  readonly counterparty: Address;
  readonly amount: bigint;
  readonly asset: AssetSymbol;
  readonly assetAddress: Address;
  /** One line, in named parameters, for the G3 review screen and the receipt. */
  readonly description: string;
};

export function resolveAsset(chainId: SupportedChainId, asset: AssetSymbol): Address {
  switch (asset) {
    case "USDC":
      return getAddress(USDC[chainId]);
  }
}

export function compileIntent(chainId: SupportedChainId, intent: Intent): CompiledAction {
  const assetAddress = resolveAsset(chainId, intent.asset);
  const pool = getAddress(AAVE_V3_POOL[chainId]);
  const amount = BigInt(intent.amount);

  switch (intent.kind) {
    case "approve": {
      const signature = "approve(address,uint256)";
      return {
        kind: intent.kind,
        target: assetAddress,
        signature,
        selector: toFunctionSelector(signature),
        calldata: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [intent.spender, amount],
        }),
        counterparty: counterparty(intent),
        amount,
        asset: intent.asset,
        assetAddress,
        description: `approve ${intent.spender} to spend ${intent.amount} ${intent.asset}`,
      };
    }
    case "supply": {
      const signature = "supply(address,uint256,address,uint16)";
      return {
        kind: intent.kind,
        target: pool,
        signature,
        selector: toFunctionSelector(signature),
        calldata: encodeFunctionData({
          abi: aavePoolAbi,
          functionName: "supply",
          // referralCode is pinned to 0: it is the one argument no caller has a reason to
          // set, and leaving it open would be a free field in a calldata we control.
          args: [assetAddress, amount, intent.onBehalfOf, 0],
        }),
        counterparty: counterparty(intent),
        amount,
        asset: intent.asset,
        assetAddress,
        description: `supply ${intent.amount} ${intent.asset} to Aave, credited to ${intent.onBehalfOf}`,
      };
    }
    case "withdraw": {
      const signature = "withdraw(address,uint256,address)";
      return {
        kind: intent.kind,
        target: pool,
        signature,
        selector: toFunctionSelector(signature),
        calldata: encodeFunctionData({
          abi: aavePoolAbi,
          functionName: "withdraw",
          args: [assetAddress, amount, intent.to],
        }),
        counterparty: counterparty(intent),
        amount,
        asset: intent.asset,
        assetAddress,
        description: `withdraw ${intent.amount} ${intent.asset} from Aave to ${intent.to}`,
      };
    }
  }
}
