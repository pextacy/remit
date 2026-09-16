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
import { canonicalJson } from "../canonical/json.js";
import { intentSchema } from "../schema/intent.js";
import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  unixSecondsSchema,
} from "../schema/primitives.js";

/**
 * What was proposed, when what was proposed was not an intent at all.
 *
 * `INTENT_MALFORMED` is the refusal a poisoned strategy earns most often — an extra
 * `data` field, a float amount, an asset named by address — and it is refused *before*
 * the intent schema admits anything. A receipt whose `intent` field only accepted valid
 * intents could therefore not record the refusal it most needs to: sealing one threw,
 * and the attempt left no trace at all, which is the one outcome PRD.md RC-1 forbids.
 *
 * So the field records it verbatim instead, under a kind that cannot be mistaken for a
 * proposal anybody could have executed. It is a string in a record, never a document
 * anything compiles: a receipt carrying this always has `action: null` and an outcome of
 * `rejected_g1`.
 */
export const unparseableIntentSchema = z
  .object({
    kind: z.literal("unparseable"),
    /** Canonical bytes of what the strategy sent, truncated. Evidence, not input. */
    raw: z.string().min(1).max(1024),
  })
  .strict();

export type UnparseableIntent = z.infer<typeof unparseableIntentSchema>;

/**
 * Coerce a value into something the canonical serialiser will accept.
 *
 * The canonicaliser deliberately refuses floats, bigints and `undefined` inside arrays,
 * because each one is a silently different document elsewhere. Those are exactly the
 * shapes this field exists to record, so they are rendered as their own text first —
 * `5.5` becomes `"5.5"` — and what comes out is still one byte sequence per input.
 */
function renderable(value: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : String(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => renderable(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        renderable(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

/** Render whatever was proposed as the evidence field above. Never throws. */
export function unparseableIntent(value: unknown): UnparseableIntent {
  let raw: string;
  try {
    raw = canonicalJson(renderable(value));
  } catch {
    raw = String(value);
  }
  if (raw === "") raw = "(empty)";
  return {
    kind: "unparseable",
    raw: raw.length > 1024 ? `${raw.slice(0, 1021)}...` : raw,
  };
}

/** What a receipt may record as the thing that was proposed. */
export const receiptIntentSchema = z.union([intentSchema, unparseableIntentSchema]);

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
  /**
   * Nothing was proposed: this record is a reading of what the chain would have said.
   * The kill switch writes two of these, before and after, so the transition is in the
   * chain rather than in a screenshot (PRD.md NH-4).
   */
  "observed",
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
    intent: receiptIntentSchema,
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
