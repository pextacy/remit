/**
 * G1 — the envelope check.
 *
 * A pure function. No network, no clock, no filesystem: `now` and the ledger come in as
 * arguments, so the same inputs always produce the same decision and a past decision can
 * be re-checked from a receipt (PRD.md G1-1). It is the cheapest of the four gates and
 * the only one that costs nothing at all, which is why it runs before any I/O.
 *
 * What it enforces, in the order a refusal is cheapest to explain (PRD.md G1-2):
 * intent shape, chain, time window, limits integrity, kind, asset, target, selector,
 * counterparty, per-transaction cap, rolling daily cap, rate limit.
 *
 * What it does *not* do is decide whether the call would succeed on chain. That is G2's
 * job and it needs an `eth_call`. G1 answers a different question — "is this inside the
 * authority the operator granted?" — and answers it without asking anyone.
 */

import type { Address } from "viem";
import { getAddress, toFunctionSelector } from "viem";
import type { SupportedChainId } from "../chain/addresses.js";
import { type CompiledAction, compileIntent } from "../compile/action.js";
import { type Intent, intentSchema } from "../schema/intent.js";
import { type Limits, limitsHash } from "../schema/limits.js";
import { microsToUsd, usdToMicros } from "../schema/primitives.js";
import type { Remit } from "../schema/remit.js";
import { type EnvelopeError, envelopeError } from "./errors.js";
import {
  countInWindow,
  DAY_SECONDS,
  HOUR_SECONDS,
  type LedgerEntry,
  spentMicros,
} from "./ledger.js";

export type EnvelopeInput = {
  readonly remit: Remit;
  /**
   * The chain the bridge is actually running against. Compared with the Remit's own
   * `chainId`: a Remit issued for Base Sepolia must not authorise anything on mainnet,
   * and the mistake is easy to make when the same limits document is used for both.
   */
  readonly chainId: SupportedChainId;
  readonly limits: Limits;
  /** Unvalidated. Whatever the strategy produced, straight from the adapter. */
  readonly intent: unknown;
  /** Unix seconds. Supplied by the caller so the gate stays pure. */
  readonly now: number;
  /** Everything G1 has already admitted. Empty is a valid starting state. */
  readonly ledger: readonly LedgerEntry[];
  /**
   * The `strategyHash` under which this agent last executed something (G3-5).
   *
   * When it differs from the one the Remit binds, the strategy has changed version since
   * anybody last watched it act — so the next action is held for review whatever its
   * size. A new version's first transaction is the one worth looking at, and it is
   * exactly the one a notional threshold waves through.
   */
  readonly seenStrategyHash?: string;
};

export type EnvelopeDecision = {
  readonly intent: Intent;
  readonly action: CompiledAction;
  /** Notional in integer micro-dollars. */
  readonly usdMicros: bigint;
  readonly usd: string;
  /** True when the action must pause at G3. */
  readonly requiresReview: boolean;
  /** Why it must pause. Undefined when it need not. */
  readonly reviewReason: string | undefined;
  /** What is left of the daily cap after this action, in micro-dollars. */
  readonly headroomMicros: bigint;
  /** The ledger entry to append once the action is admitted. */
  readonly entry: LedgerEntry;
};

export type EnvelopeResult =
  | { readonly ok: true; readonly decision: EnvelopeDecision }
  | { readonly ok: false; readonly error: EnvelopeError };

/**
 * USDC is treated as one dollar.
 *
 * Six decimals means a base unit is exactly one micro-dollar, so the conversion is the
 * identity and there is no oracle in the path — nothing for a poisoned price feed to
 * steer. It is stated here rather than buried: if a second asset is ever added, this
 * assumption has to be replaced with a real valuation, and the cap is only as honest as
 * whatever replaces it.
 */
function usdMicrosOf(action: CompiledAction): bigint {
  switch (action.asset) {
    case "USDC":
      return action.amount;
  }
}

function sameAddress(a: Address, b: Address): boolean {
  return getAddress(a) === getAddress(b);
}

export function checkEnvelope(input: EnvelopeInput): EnvelopeResult {
  const { remit, limits, now, ledger } = input;

  // ---- the intent must be one of three shapes ------------------------------
  const parsed = intentSchema.safeParse(input.intent);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // An unrecognised key fails at the root, where zod reports an empty path. "intent" is
    // more use to the person reading the receipt than an empty string.
    const field =
      issue === undefined || issue.path.length === 0 ? "intent" : issue.path.join(".");
    return {
      ok: false,
      error: envelopeError(
        "INTENT_MALFORMED",
        field,
        "an approve, supply or withdraw intent with typed fields",
        issue?.message ?? "unparseable",
        "the strategy produced something that is not a valid intent",
      ),
    };
  }
  const intent = parsed.data;

  // ---- the Remit must be the right one, and live ---------------------------
  if (remit.chainId !== input.chainId) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_CHAIN_MISMATCH",
        "chainId",
        `a Remit for chain ${input.chainId}`,
        `a Remit for chain ${remit.chainId}`,
        "the Remit was issued for another chain",
      ),
    };
  }

  if (now < remit.notBefore) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_NOT_YET_VALID",
        "notBefore",
        `on or after ${remit.notBefore}`,
        String(now),
        "the Remit is not in force yet",
      ),
    };
  }

  if (now > remit.notAfter) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_EXPIRED",
        "notAfter",
        `on or before ${remit.notAfter}`,
        String(now),
        "the Remit has expired — reissue it rather than widening it",
      ),
    };
  }

  // ---- the limits handed to the gate must be the ones the Remit binds ------
  // Without this, the gate would enforce whatever limits document it was passed, and the
  // hash in the Remit would be decoration.
  const computed = limitsHash(limits);
  if (computed !== remit.limitsHash) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_LIMITS_MISMATCH",
        "limitsHash",
        remit.limitsHash,
        computed,
        "the limits document does not hash to the value the Remit binds",
      ),
    };
  }

  // ---- is this action inside the envelope at all? --------------------------
  if (!limits.allowedIntentKinds.includes(intent.kind)) {
    return {
      ok: false,
      error: envelopeError(
        "OUT_OF_REMIT_KIND",
        "kind",
        limits.allowedIntentKinds.join(", "),
        intent.kind,
        "the Remit does not permit this kind of action",
      ),
    };
  }

  if (!limits.allowedAssets.includes(intent.asset)) {
    return {
      ok: false,
      error: envelopeError(
        "OUT_OF_REMIT_ASSET",
        "asset",
        limits.allowedAssets.join(", "),
        intent.asset,
        "the Remit does not permit this asset",
      ),
    };
  }

  const action = compileIntent(remit.chainId, intent);

  if (!limits.allowedTargets.some((target) => sameAddress(target, action.target))) {
    return {
      ok: false,
      error: envelopeError(
        "OUT_OF_REMIT_TARGET",
        "target",
        limits.allowedTargets.join(", "),
        action.target,
        "the Remit does not permit calls to this contract",
      ),
    };
  }

  const allowedSelectors = limits.allowedSelectors.map((signature) =>
    toFunctionSelector(signature),
  );
  if (!allowedSelectors.includes(action.selector)) {
    return {
      ok: false,
      error: envelopeError(
        "OUT_OF_REMIT_SELECTOR",
        "selector",
        limits.allowedSelectors.join(", "),
        `${action.signature} (${action.selector})`,
        "the Remit does not permit this function",
      ),
    };
  }

  // `approve` names a spender, not a recipient: the question is who may pull value, and
  // the answer is only a contract the role may call anyway. Checking a spender against
  // the recipient list would let an approve to an attacker pass any list containing the
  // Safe — which every list does.
  if (intent.kind === "approve") {
    if (
      !limits.allowedTargets.some((target) => sameAddress(target, action.counterparty))
    ) {
      return {
        ok: false,
        error: envelopeError(
          "OUT_OF_REMIT_SPENDER",
          "spender",
          limits.allowedTargets.join(", "),
          action.counterparty,
          "the Remit does not permit approving this spender",
        ),
      };
    }
  } else if (
    !limits.allowedRecipients.some((recipient) =>
      sameAddress(recipient, action.counterparty),
    )
  ) {
    return {
      ok: false,
      error: envelopeError(
        "OUT_OF_REMIT_RECIPIENT",
        intent.kind === "supply" ? "onBehalfOf" : "to",
        limits.allowedRecipients.join(", "),
        action.counterparty,
        "the Remit does not permit value to land at this address",
      ),
    };
  }

  // ---- permitted in kind; now in size --------------------------------------
  const usdMicros = usdMicrosOf(action);
  const perTxCap = usdToMicros(limits.perTxCapUsd);
  if (usdMicros > perTxCap) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_CAP_EXCEEDED_PER_TX",
        "perTxCapUsd",
        `${limits.perTxCapUsd} USD`,
        `${microsToUsd(usdMicros)} USD`,
        "the action is larger than the Remit's per-transaction cap",
      ),
    };
  }

  const dailyCap = usdToMicros(limits.dailyCapUsd);
  const alreadySpent = spentMicros(ledger, now, DAY_SECONDS);
  const wouldSpend = intent.kind === "supply" ? usdMicros : 0n;
  if (alreadySpent + wouldSpend > dailyCap) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_CAP_EXCEEDED_DAILY",
        "dailyCapUsd",
        `${limits.dailyCapUsd} USD in 24h`,
        `${microsToUsd(alreadySpent + wouldSpend)} USD`,
        "the action would exceed the Remit's rolling daily cap",
      ),
    };
  }

  const recentCount = countInWindow(ledger, now, HOUR_SECONDS);
  if (recentCount + 1 > limits.maxTxPerHour) {
    return {
      ok: false,
      error: envelopeError(
        "REMIT_RATE_LIMIT_EXCEEDED",
        "maxTxPerHour",
        `${limits.maxTxPerHour} per hour`,
        `${recentCount + 1} in the last hour`,
        "the agent is acting faster than the Remit allows",
      ),
    };
  }

  const overThreshold = usdMicros > usdToMicros(limits.requireReviewAboveUsd);
  const strategyChanged =
    input.seenStrategyHash !== undefined &&
    input.seenStrategyHash.toLowerCase() !== remit.strategyHash.toLowerCase();
  const requiresReview = overThreshold || strategyChanged;

  return {
    ok: true,
    decision: {
      intent,
      action,
      usdMicros,
      usd: microsToUsd(usdMicros),
      requiresReview,
      reviewReason: strategyChanged
        ? "the strategy has changed version since this agent last executed"
        : overThreshold
          ? `above the Remit's review threshold of ${limits.requireReviewAboveUsd} USD`
          : undefined,
      headroomMicros: dailyCap - (alreadySpent + wouldSpend),
      entry: { at: now, usdMicros: usdMicros.toString(), kind: intent.kind },
    },
  };
}
