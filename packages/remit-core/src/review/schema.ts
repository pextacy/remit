/**
 * G3 — the queue a human looks at.
 *
 * An action above the Remit's `requireReviewAboveUsd` stops here and waits. That is the
 * only gate in the four whose cost is a person's attention, so the queue is built to
 * spend as little of it as possible: the decoded action in named parameters, the two
 * gates that already passed, and the money. Never raw calldata — an operator asked to
 * approve a hex blob is an operator being asked to rubber-stamp (PRD.md G3-2).
 *
 * A decision is a separate file from the item it decides. Appending rather than mutating
 * means a decision cannot be quietly changed, and the pair is what the receipt records.
 */
import { z } from "zod";
import { intentSchema } from "../schema/intent.js";
import { addressSchema, bytes32Schema, unixSecondsSchema } from "../schema/primitives.js";

export const reviewItemSchema = z
  .object({
    id: z.string().min(1),
    at: unixSecondsSchema,
    network: z.string().min(1),
    remitHash: bytes32Schema,
    intent: intentSchema,
    action: z
      .object({
        target: addressSchema,
        signature: z.string().min(1),
        selector: z.string().min(1),
        description: z.string().min(1),
        usd: z.string().min(1),
      })
      .strict(),
    /** What G1 and G2 already said. A reviewer should not be the first to check. */
    gates: z
      .array(
        z
          .object({
            gate: z.enum(["G1", "G2"]),
            outcome: z.enum(["pass", "refused"]),
            detail: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    /** What remains of the daily cap if this is approved. */
    headroomUsd: z.string().min(1),
    /** Why it stopped: the threshold it exceeded. */
    reason: z.string().min(1),
  })
  .strict();

export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const reviewDecisionSchema = z
  .object({
    id: z.string().min(1),
    at: unixSecondsSchema,
    decision: z.enum(["approved", "declined"]),
    /** Who decided. Free text: the console has one operator session, not accounts. */
    by: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
