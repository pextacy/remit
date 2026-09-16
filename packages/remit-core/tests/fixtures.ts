/**
 * One Remit, one limits document, one Safe — shared by every test that needs a world.
 *
 * Built the way the ops tooling builds them, so a test that passes here is a test about
 * the documents the project actually issues rather than about a shape invented for it.
 */
import { getAddress } from "viem";
import { AAVE_V3_POOL, BASE_SEPOLIA, USDC } from "../src/chain/addresses.js";
import { remitDigest } from "../src/eip712/remit.js";
import { type Limits, limitsHash, limitsSchema } from "../src/schema/limits.js";
import { type Remit, remitSchema } from "../src/schema/remit.js";

export const CHAIN = BASE_SEPOLIA;
export const SAFE = getAddress("0xe7533B43310a2660bf3d50CEF792D77d32A73D64");
export const ATTACKER = getAddress("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
export const AGENT = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
export const ROLES = getAddress("0x1A500342644ce5BAA9485afaf84bB78d5E9d34De");
export const ROLE_KEY =
  "0x72656d69742d6167656e74000000000000000000000000000000000000000000" as const;
export const STRATEGY_HASH = `0x${"11".repeat(32)}` as const;
export const WORKFLOW_HASH = `0x${"22".repeat(32)}` as const;

export const USDC_ADDRESS = getAddress(USDC[CHAIN]);
export const POOL = getAddress(AAVE_V3_POOL[CHAIN]);

/** Unix seconds, fixed. The gate is pure, so a test never needs the real clock. */
export const NOW = 1_800_000_000;

export function limitsFor(overrides: Partial<Limits> = {}): Limits {
  return limitsSchema.parse({
    allowedIntentKinds: ["approve", "supply", "withdraw"],
    allowedTargets: [USDC_ADDRESS, POOL],
    allowedSelectors: [
      "approve(address,uint256)",
      "supply(address,uint256,address,uint16)",
      "withdraw(address,uint256,address)",
    ],
    allowedRecipients: [SAFE],
    allowedAssets: ["USDC"],
    perTxCapUsd: "5",
    dailyCapUsd: "25",
    requireReviewAboveUsd: "1",
    maxTxPerHour: 6,
    maxSlippageBps: 50,
    ...overrides,
  });
}

export function remitFor(limits: Limits, overrides: Partial<Remit> = {}): Remit {
  return remitSchema.parse({
    strategyHash: STRATEGY_HASH,
    workflowHash: WORKFLOW_HASH,
    safe: SAFE,
    rolesModifier: ROLES,
    roleKey: ROLE_KEY,
    limitsHash: limitsHash(limits),
    chainId: CHAIN,
    notBefore: NOW - 3600,
    notAfter: NOW + 7 * 86_400,
    nonce: "1",
    ...overrides,
  });
}

export const LIMITS = limitsFor();
export const REMIT = remitFor(LIMITS);
export const REMIT_HASH = remitDigest(REMIT);

/** `"5"` → `"5000000"`. USDC has six decimals. */
export function usdc(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  return (
    BigInt(whole) * 1_000_000n +
    BigInt(fraction.padEnd(6, "0").slice(0, 6))
  ).toString();
}
