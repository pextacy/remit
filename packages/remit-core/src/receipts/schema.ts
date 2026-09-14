/**
 * The provenance receipt: one record per attempt, including the attempts that were
 * refused (PRD.md RC-1).
 *
 * A receipt answers, for a transaction that exists on a public chain, the question nobody
 * can answer today: *which version of which strategy produced this, under whose authority,
 * and was that authority ever exceeded?* It carries the five hashes that make the answer
 * checkable — strategyHash → remitHash → workflowHash → roleKey → txHash — and it is
 * chained to the one before it so a record cannot be removed without the removal showing.
 *
 * Refusals are recorded for the same reason successes are. A log that only contains what
 * worked is a log that has been edited.
 */
import { z } from "zod";
import { intentSchema } from "../schema/intent.js";
import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  unixSecondsSchema,
} from "../schema/primitives.js";

/** The gate that decided, and what it decided. */
export const gateOutcomeSchema = z
  .object({
    gate: z.enum(["G1", "G2", "G3", "G4"]),
    outcome: z.enum(["pass", "refused", "declined", "reverted", "skipped"]),
    /** The typed code — an envelope error code, or a Roles Status name. */
    code: z.string().optional(),
    /** One line a person can read. */
    detail: z.string().optional(),
  })
  .strict();

export type GateOutcome = z.infer<typeof gateOutcomeSchema>;

/**
 * How the transaction was submitted, if it was.
 *
 * `path` exists so that no receipt can imply KeeperHub executed something it did not.
 * `keeperhub` is the product path (KH-1). `ops-direct` is the operator's hand-run path
 * from P1 — a signer calling the Roles Modifier itself — and it is recorded under its own
 * name precisely so that a reader can tell the two apart without trusting a narrative.
 */
export const submissionSchema = z
  .object({
    path: z.enum(["keeperhub", "ops-direct", "none"]),
    /** KeeperHub's execution id. The only key `txHash` is correlated on (KH-4). */
    executionId: z.string().min(1).nullable(),
    workflowId: z.string().min(1).nullable(),
    txHash: bytes32Schema.nullable(),
    explorer: z.string().url().nullable(),
    gasUsed: z.string().nullable(),
  })
  .strict();

export type Submission = z.infer<typeof submissionSchema>;

export const receiptOutcomeSchema = z.enum([
  "executed",
  "rejected_g1",
  "rejected_g2",
  "declined_g3",
  "reverted_g4",
  /** The transaction may exist; we could not prove which one it was. Never guessed. */
  "unresolved",
]);

export type ReceiptOutcome = z.infer<typeof receiptOutcomeSchema>;

/** A receipt without its own hash — the bytes that `selfHash` is taken over. */
export const receiptBodySchema = z
  .object({
    /** Schema version. A receipt outlives the code that wrote it. */
    version: z.literal(1),
    sequence: z.number().int().min(0),
    at: unixSecondsSchema,
    network: z.string().min(1),
    chainId: chainIdSchema,

    // ---- the five hashes -------------------------------------------------
    remitHash: bytes32Schema,
    strategyHash: bytes32Schema,
    workflowHash: bytes32Schema,
    limitsHash: bytes32Schema,
    roleKey: bytes32Schema,

    safe: addressSchema,
    rolesModifier: addressSchema,
    agent: addressSchema,

    // ---- what was proposed, and what became of it ------------------------
    intent: intentSchema,
    /**
     * The compiled call — target, function, named parameters.
     *
     * Null when the intent never reached the compiler, which is what a G1 refusal is:
     * the gate ran before any bytes were built. Filling it with placeholder values
     * would be inventing a call that was never made.
     */
    action: z
      .object({
        target: addressSchema,
        signature: z.string().min(1),
        selector: z.string().min(1),
        /** Named parameters, not raw calldata. The calldata is derivable from the intent. */
        description: z.string().min(1),
        usd: z.string().min(1),
      })
      .strict()
      .nullable(),
    gates: z.array(gateOutcomeSchema).min(1),
    outcome: receiptOutcomeSchema,
    submission: submissionSchema,

    /** The previous receipt's `selfHash`. Zero for the first record in a chain. */
    prevHash: bytes32Schema,
  })
  .strict();

export type ReceiptBody = z.infer<typeof receiptBodySchema>;

export const receiptSchema = receiptBodySchema.extend({
  /** keccak256 over the canonical JSON of every field above. */
  selfHash: bytes32Schema,
});

export type Receipt = z.infer<typeof receiptSchema>;

/** The head of a chain that has no records yet. */
export const GENESIS_PREV_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
