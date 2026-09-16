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

/**
 * A review id, and the only shape one may take.
 *
 * The id names a file on disk in both directions: the bridge writes `<id>.json` into the
 * queue and the console writes `<id>.json` into the decisions directory, from a form
 * field. Anything that can contain a separator or a `..` is therefore a write outside the
 * queue by whoever can reach the console, so the shape is pinned here — at the schema
 * both halves share — rather than trusted to each caller.
 *
 * `randomUUID()`, which is what produces these, fits comfortably.
 */
export const reviewIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "not a review id");

export const reviewItemSchema = z
  .object({
    id: reviewIdSchema,
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
    /** Why it stopped: the threshold it exceeded, or a changed strategy version. */
    reason: z.string().min(1),
    /**
     * What the Safe's USDC balance would do, simulated against current state (G3-4).
     *
     * The check on whether the call does what its name says. Absent when the node cannot
     * simulate asset changes — a review screen that invents a delta is worse than one
     * that admits it does not have it.
     */
    balanceDelta: z
      .object({ usdc: z.string().min(1), note: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const reviewDecisionSchema = z
  .object({
    id: reviewIdSchema,
    at: unixSecondsSchema,
    decision: z.enum(["approved", "declined"]),
    /** Who decided. Free text: the console has one operator session, not accounts. */
    by: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
