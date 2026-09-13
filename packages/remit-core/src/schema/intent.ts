/**
 * An Intent: a typed, schema-valid action a strategy wants taken. Not calldata.
 *
 * This file is where CLAUDE.md §2.3 is enforced mechanically. Read what an intent can
 * carry: a kind from a closed set, an asset **symbol**, an amount as a decimal string,
 * and one address that names a counterparty. There is no `data` field, no `to` field, no
 * `abi` field, no selector. A strategy — or a model steering one — cannot express a call
 * that is not one of three shapes, so there is no path by which model output becomes
 * calldata. The compiler in `../compile` builds the bytes from the verified ABIs.
 *
 * Adding a field to this union is a security decision, not a feature decision.
 */
import { z } from "zod";
import { addressSchema, assetSymbolSchema, uintStringSchema } from "./primitives.js";

const base = {
  /** Amount in base units of the asset. 5 USDC is "5000000". */
  amount: uintStringSchema,
  asset: assetSymbolSchema,
};

export const approveIntentSchema = z
  .object({
    kind: z.literal("approve"),
    ...base,
    /** Who may pull the asset. Checked against the allowed targets, not the recipients. */
    spender: addressSchema,
  })
  .strict();

export const supplyIntentSchema = z
  .object({
    kind: z.literal("supply"),
    ...base,
    /** Who is credited the position. The preset pins this to the Safe on chain. */
    onBehalfOf: addressSchema,
  })
  .strict();

export const withdrawIntentSchema = z
  .object({
    kind: z.literal("withdraw"),
    ...base,
    /** Where the funds land. The preset pins this to the Safe on chain. */
    to: addressSchema,
  })
  .strict();

export const intentSchema = z.discriminatedUnion("kind", [
  approveIntentSchema,
  supplyIntentSchema,
  withdrawIntentSchema,
]);

export type ApproveIntent = z.infer<typeof approveIntentSchema>;
export type SupplyIntent = z.infer<typeof supplyIntentSchema>;
export type WithdrawIntent = z.infer<typeof withdrawIntentSchema>;
export type Intent = z.infer<typeof intentSchema>;

/**
 * The counterparty address an intent names.
 *
 * For `supply` and `withdraw` this is where value goes, and it is checked against
 * `allowedRecipients` — the Safe. For `approve` it is who may pull value, which is a
 * different question with a different answer: the spender is checked against
 * `allowedTargets`, because the only contracts worth approving are the ones the role may
 * call anyway. Collapsing the two checks into one would let an approve to an attacker
 * pass any list that contains the Safe.
 */
export function counterparty(intent: Intent): `0x${string}` {
  switch (intent.kind) {
    case "approve":
      return intent.spender;
    case "supply":
      return intent.onBehalfOf;
    case "withdraw":
      return intent.to;
  }
}
