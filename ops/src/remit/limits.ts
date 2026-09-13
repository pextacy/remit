/**
 * The limits document for a deployment.
 *
 * Built from the same verified addresses the preset is built from, so the two cannot
 * drift by transcription. They can still drift by intent — someone widens one and not the
 * other — which is why the bridge asserts they agree at startup (PRD.md RM-4, P5).
 *
 * The caps are the ones in CLAUDE.md §2.4: 5 USDC per transaction, 25 USDC per day. They
 * are not raised to make a test pass.
 */

import { AAVE_V3_POOL, type Limits, type SupportedChainId, USDC } from "@remit/core";
import { type Address, getAddress } from "viem";

export const DEMO_CAPS = {
  perTxCapUsd: "5",
  dailyCapUsd: "25",
  requireReviewAboveUsd: "1",
  maxTxPerHour: 6,
} as const;

export function buildLimits(
  chainId: SupportedChainId,
  safe: Address,
  caps: {
    perTxCapUsd?: string;
    dailyCapUsd?: string;
    requireReviewAboveUsd?: string;
    maxTxPerHour?: number;
  } = {},
): Limits {
  return {
    allowedIntentKinds: ["approve", "supply", "withdraw"],
    // The two contracts the preset scopes, in the same order the preset clears them.
    allowedTargets: [getAddress(USDC[chainId]), getAddress(AAVE_V3_POOL[chainId])],
    allowedSelectors: [
      "approve(address,uint256)",
      "supply(address,uint256,address,uint16)",
      "withdraw(address,uint256,address)",
    ],
    // The Safe and nothing else. This one line is why exfiltration is unrepresentable.
    allowedRecipients: [getAddress(safe)],
    allowedAssets: ["USDC"],
    perTxCapUsd: caps.perTxCapUsd ?? DEMO_CAPS.perTxCapUsd,
    dailyCapUsd: caps.dailyCapUsd ?? DEMO_CAPS.dailyCapUsd,
    requireReviewAboveUsd: caps.requireReviewAboveUsd ?? DEMO_CAPS.requireReviewAboveUsd,
    maxTxPerHour: caps.maxTxPerHour ?? DEMO_CAPS.maxTxPerHour,
    // No swap intent exists in this build, so no slippage is ever consulted. The field is
    // in the hashed document so that adding one later changes limitsHash, which forces a
    // reissued Remit rather than a silent widening.
    maxSlippageBps: 50,
  };
}
