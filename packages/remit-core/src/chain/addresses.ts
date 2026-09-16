/**
 * Every external address this project touches, on the only two chains it runs on.
 *
 * Nothing here was recalled. Each value came from a pinned upstream source and was then
 * confirmed against the chain itself with `cast` on 2026-09-13. The row for each one —
 * source URL, commit, probe, date — is in docs/VERIFIED.md. A plausible wrong address
 * moves real money to nowhere (CLAUDE.md §2.2), so treat this file as append-only and
 * add the VERIFIED.md row in the same commit.
 */

/** Base mainnet. Real money. Every script defaults away from this (CLAUDE.md §2.4). */
export const BASE = 8453 as const;
/** Base Sepolia. The default network for every script and the live demo. */
export const BASE_SEPOLIA = 84_532 as const;

export type SupportedChainId = typeof BASE | typeof BASE_SEPOLIA;

export const SUPPORTED_CHAIN_IDS: readonly SupportedChainId[] = [BASE, BASE_SEPOLIA];

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return (SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId);
}

/**
 * Zodiac Roles Modifier v2 and the Zodiac ModuleProxyFactory.
 *
 * Both are deployed with Nick's method, so the address is identical on both chains —
 * confirmed by `cast code` returning byte-identical runtime code (48805 and 4095 hex
 * chars respectively) on 8453 and 84532.
 *
 * The mastercopy is version **2.1.0**, not 2.0.0: `packages/evm/mastercopies.json` in
 * gnosisguild/zodiac-modifier-roles maps this address to the `Roles` `2.1.0` entry, and
 * that repo's `packages/evm` is itself at 2.1.0.
 */
export const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337" as const;
export const ROLES_MASTERCOPY_VERSION = "2.1.0" as const;
export const MODULE_PROXY_FACTORY = "0x000000000000aDdB49795b0f9bA5BC298cDda236" as const;

/**
 * Safe v1.4.1 singletons and the proxy factory, also identical on both chains.
 * `VERSION()` answers "1.4.1" on Base mainnet for both singletons.
 *
 * Use `SAFE_L2_SINGLETON` on Base and Base Sepolia: the L2 singleton emits the events
 * the Safe transaction service indexes on non-mainnet chains.
 */
export const SAFE_SINGLETON = "0x41675C099F32341bf84BFc5382aF534df5C7461a" as const;
export const SAFE_L2_SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762" as const;
export const SAFE_PROXY_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as const;
export const SAFE_VERSION = "1.4.1" as const;

/**
 * Aave v3 Pool, per chain. `ADDRESSES_PROVIDER()` was called on both and matches the
 * `POOL_ADDRESSES_PROVIDER` constant in the same address-book file the POOL came from.
 */
export const AAVE_V3_POOL: Readonly<Record<SupportedChainId, `0x${string}`>> = {
  [BASE]: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  [BASE_SEPOLIA]: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
};

export const AAVE_V3_POOL_ADDRESSES_PROVIDER: Readonly<
  Record<SupportedChainId, `0x${string}`>
> = {
  [BASE]: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  [BASE_SEPOLIA]: "0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00",
};

/**
 * USDC, per chain — the only asset the demo moves.
 *
 * On Base this is Circle's native USDC. On Base Sepolia it is **not** Circle's testnet
 * USDC: it is the token Aave actually lists in its Base Sepolia market, which is the one
 * the pool will accept in `supply`. Picking the other one gives a revert that looks like
 * a preset failure and is not.
 */
export const USDC: Readonly<Record<SupportedChainId, `0x${string}`>> = {
  [BASE]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [BASE_SEPOLIA]: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
};

export const USDC_DECIMALS = 6 as const;

/**
 * Circle's testnet USDC on Base Sepolia — the token this build does **not** use.
 *
 * It is here so a check can name it, not so anything can reach for it. Aave's Base
 * Sepolia market lists the token above; Circle's faucet hands out this one; and the two
 * are indistinguishable from the outside — both answer `symbol()` with "USDC" and
 * `decimals()` with 6. Funding a Safe from the wrong faucet therefore looks exactly like
 * funding it from the right one, right up to a `supply` that reverts inside Aave for a
 * reason that reads as a preset failure.
 *
 * Verified on Base Sepolia 2026-09-15: `symbol()` "USDC", `decimals()` 6, and the aUSDC
 * at `AAVE_V3_A_USDC[84532]` answers `UNDERLYING_ASSET_ADDRESS()` with the *other* one.
 * On Base mainnet there is no such pair — Circle's native USDC is the token Aave lists —
 * so this is Base Sepolia only.
 */
export const CIRCLE_TESTNET_USDC_BASE_SEPOLIA =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/**
 * Aave's interest-bearing USDC token, per chain.
 *
 * Source: aave-dao/aave-address-book, `USDC.A_TOKEN`, commit
 * `02748a20592a019e834aee193b6c40c9bc7bd059`. Both answer
 * `UNDERLYING_ASSET_ADDRESS()` with the `USDC` address above. Verified 2026-09-14.
 *
 * Not used by the product. It is the only thing here that exists for the rehearsal: on a
 * fork of Base mainnet there is no faucet and Circle's USDC has no public `mint`, so the
 * Safe is funded by impersonating this contract — which really does hold millions of real
 * USDC — and transferring. Forked real state, moved by its real holder.
 */
export const AAVE_V3_A_USDC: Readonly<Record<SupportedChainId, `0x${string}`>> = {
  [BASE]: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
  [BASE_SEPOLIA]: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
};

/** Public RPC endpoints, used only for verification probes. Real runs use $BASE_RPC_URL. */
export const PUBLIC_RPC: Readonly<Record<SupportedChainId, string>> = {
  [BASE]: "https://mainnet.base.org",
  [BASE_SEPOLIA]: "https://sepolia.base.org",
};

/** Block explorers, for receipt links (PRD.md RC-5). */
export const EXPLORER: Readonly<Record<SupportedChainId, string>> = {
  [BASE]: "https://basescan.org",
  [BASE_SEPOLIA]: "https://sepolia.basescan.org",
};
