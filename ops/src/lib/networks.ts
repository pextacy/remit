/**
 * Networks, and the rule that mainnet is never the default (CLAUDE.md §2.4).
 *
 * `anvil` is a local fork of Base Sepolia. It reports chain id 84532 because it is that
 * chain's state, which is exactly why it is the only acceptable substitute for it: forked
 * real state is not a mock, hand-authored JSON is.
 */
import { BASE, BASE_SEPOLIA, type SupportedChainId } from "@remit/core";
import { fail } from "./log.js";

export type NetworkName = "anvil" | "anvil-base" | "base-sepolia" | "base";

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

/**
 * An environment variable that is set to nothing is not a value.
 *
 * `process.env.X ?? fallback` only falls back on `undefined`, and `.env.example` ships
 * every optional RPC as `BASE_SEPOLIA_RPC_URL=` with nothing after it — which is how an
 * operator is *told* to leave one unset. Sourcing that gave viem an empty URL and
 * "No URL was provided to the Transport", pointing at a library rather than at the line
 * the operator wrote. The mainnet branch below already treated empty as unset; the other
 * three did not, so following the repository's own example file broke three networks and
 * left the fourth working.
 */
function envUrl(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export function resolveNetwork(name: string): Network {
  switch (name) {
    case "anvil":
      return {
        name: "anvil",
        chainId: BASE_SEPOLIA,
        rpcUrl: envUrl("ANVIL_RPC_URL", DEFAULT_ANVIL_RPC),
        canImpersonate: true,
        isMainnet: false,
      };
    // A fork of Base **mainnet**: chain 8453's real state, real contracts, real USDC,
    // real Aave pool. It is where the mainnet run is rehearsed — the addresses, the
    // preset and the caps are the ones that will be used for real, and the only thing
    // that differs is whose money it is.
    case "anvil-base":
      return {
        name: "anvil-base",
        chainId: BASE,
        rpcUrl: envUrl("ANVIL_BASE_RPC_URL", "http://127.0.0.1:8547"),
        canImpersonate: true,
        // Not mainnet: nothing here reaches a public chain. The ceremony is rehearsed
        // anyway, because a path only practised without its flags is a path nobody has
        // practised.
        isMainnet: false,
      };
    case "base-sepolia":
      return {
        name: "base-sepolia",
        chainId: BASE_SEPOLIA,
        rpcUrl: envUrl("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
        canImpersonate: false,
        isMainnet: false,
      };
    case "base": {
      const rpcUrl = process.env.BASE_RPC_URL?.trim();
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
        `unknown network "${name}" — expected anvil, anvil-base, base-sepolia or base ` +
          "(default: base-sepolia)",
      );
  }
}
