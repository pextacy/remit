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

import {
  AAVE_V3_POOL,
  type Limits,
  limitsSchema,
  type SupportedChainId,
  USDC,
  usdToMicros,
} from "@remit/core";
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
  // Parsed, not merely typed. The caps arrive from `--per-tx` and `--daily` as whatever
  // the operator typed, and a cap that is not a USD amount — "5,00", "1e6", "abc" — would
  // otherwise be hashed into `limitsHash`, signed, and only discovered at the moment G1
  // tried to compare against it. A limits document that cannot be compared is a cap that
  // fails open.
  const parsed = limitsSchema.safeParse({
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
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `these limits are not a valid limits document: ${issue?.path.join(".") ?? "?"} ` +
        `— ${issue?.message ?? "unparseable"}`,
    );
  }

  return parsed.data;
}

/**
 * Does one limits document permit more than another?
 *
 * `roles:apply` will not widen the on-chain preset without `--yes`, on any network,
 * because "a flag only ever typed for real is a flag nobody has typed". Reissuing a Remit
 * had no such ceremony — and the preset leaves `amount` as `Pass`, so the caps that
 * actually bound the money live in this document rather than on chain. Doubling the daily
 * cap was a quieter act than re-scoping a function that changes nothing about how much
 * can move.
 *
 * Narrowing returns nothing. That is what fixing a mistake looks like, and making it cost
 * a flag teaches an operator to type the flag.
 *
 * A rule rather than a line in a script, so it can be tested without issuing anything.
 */
export function widenings(previous: Limits, next: Limits): readonly string[] {
  const lines: string[] = [];

  const moreMoney = (
    field: "perTxCapUsd" | "dailyCapUsd" | "requireReviewAboveUsd",
    why: string,
  ): void => {
    if (usdToMicros(next[field]) > usdToMicros(previous[field])) {
      lines.push(`${field} ${previous[field]} → ${next[field]} USD — ${why}`);
    }
  };

  moreMoney("perTxCapUsd", "each action may be larger");
  moreMoney("dailyCapUsd", "more may move in a day");
  // Raising the review threshold is a widening of a different kind: the same money moves
  // with fewer people looking at it.
  moreMoney("requireReviewAboveUsd", "fewer actions stop for a person");

  if (next.maxTxPerHour > previous.maxTxPerHour) {
    lines.push(
      `maxTxPerHour ${previous.maxTxPerHour} → ${next.maxTxPerHour} — the agent may act faster`,
    );
  }
  if (next.maxSlippageBps > previous.maxSlippageBps) {
    lines.push(`maxSlippageBps ${previous.maxSlippageBps} → ${next.maxSlippageBps}`);
  }

  const gained = (
    field:
      | "allowedIntentKinds"
      | "allowedAssets"
      | "allowedTargets"
      | "allowedRecipients"
      | "allowedSelectors",
  ): void => {
    const before = new Set<string>(previous[field].map(String));
    const added = next[field].map(String).filter((value) => !before.has(value));
    if (added.length > 0) lines.push(`${field} gains ${added.join(", ")}`);
  };

  gained("allowedIntentKinds");
  gained("allowedAssets");
  gained("allowedTargets");
  gained("allowedRecipients");
  gained("allowedSelectors");

  return lines;
}
