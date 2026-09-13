/**
 * The limits object: how much, where, when (DOCS.md §2.2).
 *
 * Canonicalised and hashed into `limitsHash`, which the Remit binds. Every field here has
 * a counterpart in the Roles preset, and the bridge refuses to start if the two disagree
 * (PRD.md RM-4) — the preset is the authority, this is the declaration.
 */

import type { Hex } from "viem";
import { z } from "zod";
import { canonicalHash } from "../canonical/json.js";
import { addressSchema, assetSymbolSchema, usdStringSchema } from "./primitives.js";

/** The three actions this build knows how to take. Nothing else is expressible. */
export const intentKindSchema = z.enum(["approve", "supply", "withdraw"]);
export type IntentKind = z.infer<typeof intentKindSchema>;

export const limitsSchema = z
  .object({
    /** Kinds the agent may propose at all. */
    allowedIntentKinds: z.array(intentKindSchema).min(1),
    /** Contracts the agent may call. Must match the preset's scoped targets. */
    allowedTargets: z.array(addressSchema).min(1),
    /** Function signatures, not selectors: readable in a diff, hashed the same either way. */
    allowedSelectors: z
      .array(z.string().regex(/^[a-zA-Z_][\w]*\((|[\w,[\]]+)\)$/))
      .min(1),
    /**
     * Where value may land. In practice this is the Safe and only the Safe, which is what
     * makes exfiltration unrepresentable rather than merely disallowed.
     */
    allowedRecipients: z.array(addressSchema).min(1),
    /** Assets the agent may touch. */
    allowedAssets: z.array(assetSymbolSchema).min(1),
    perTxCapUsd: usdStringSchema,
    dailyCapUsd: usdStringSchema,
    /** Actions above this notional pause for a human at G3. */
    requireReviewAboveUsd: usdStringSchema,
    maxTxPerHour: z.number().int().min(1).max(1000),
    /** Reserved for swap intents, which this build does not implement. */
    maxSlippageBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export type Limits = z.infer<typeof limitsSchema>;

/**
 * keccak256 of the canonical limits JSON.
 *
 * Reproducible by anyone holding the committed document, which is the whole point: the
 * Remit binds a hash, and a third party must be able to re-derive it (PRD.md RM-3).
 */
export function limitsHash(limits: Limits): Hex {
  return canonicalHash(limits);
}
