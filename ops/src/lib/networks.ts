/**
 * Networks, and the rule that mainnet is never the default (CLAUDE.md §2.4).
 *
 * `anvil` is a local fork of Base Sepolia. It reports chain id 84532 because it is that
 * chain's state, which is exactly why it is the only acceptable substitute for it: forked
 * real state is not a mock, hand-authored JSON is.
 */
import { BASE, BASE_SEPOLIA, type SupportedChainId } from "@remit/core";
import { fail } from "./log.js";

export type NetworkName = "anvil" | "base-sepolia" | "base";

export type Network = {
  readonly name: NetworkName;
  readonly chainId: SupportedChainId;
  readonly rpcUrl: string;
  /** Anvil lets us act as any address without a key. No other network does. */
  readonly canImpersonate: boolean;
  /** True for Base mainnet only. Guards every write path. */
  readonly isMainnet: boolean;
};

const DEFAULT_ANVIL_RPC = "http://127.0.0.1:8545";

export function resolveNetwork(name: string): Network {
  switch (name) {
    case "anvil":
      return {
        name: "anvil",
        chainId: BASE_SEPOLIA,
        rpcUrl: process.env.ANVIL_RPC_URL ?? DEFAULT_ANVIL_RPC,
        canImpersonate: true,
        isMainnet: false,
      };
    case "base-sepolia":
      return {
        name: "base-sepolia",
        chainId: BASE_SEPOLIA,
        rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
        canImpersonate: false,
        isMainnet: false,
      };
    case "base": {
      const rpcUrl = process.env.BASE_RPC_URL;
      if (rpcUrl === undefined || rpcUrl === "") {
        fail("BASE_RPC_URL is required for --network base");
      }
      return {
        name: "base",
        chainId: BASE,
        rpcUrl,
        canImpersonate: false,
        isMainnet: true,
      };
    }
    default:
      return fail(
        `unknown network "${name}" — expected anvil, base-sepolia or base (default: base-sepolia)`,
      );
  }
}
