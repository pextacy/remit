/**
 * The Remit: the unit of delegated authority (DOCS.md §2).
 *
 * Ten fields that must agree or nothing executes. `remitHash` — the EIP-712 digest of
 * this struct — is the primary key of the whole system: receipts reference it, the
 * console displays it, and the bridge refuses to act without one.
 */
import { z } from "zod";
import { limitsSchema } from "./limits.js";
import {
  addressSchema,
  bytes32Schema,
  chainIdSchema,
  uintStringSchema,
  unixSecondsSchema,
} from "./primitives.js";

export const remitSchema = z
  .object({
    /** keccak256 of the pinned Almanak strategy source. *Why* the action happened. */
    strategyHash: bytes32Schema,
    /** keccak256 of the canonicalised KeeperHub workflow definition. *What* runs. */
    workflowHash: bytes32Schema,
    safe: addressSchema,
    rolesModifier: addressSchema,
    /** The role the agent's signer is a member of. *What is permitted at all.* */
    roleKey: bytes32Schema,
    /** keccak256 of the canonical limits object. *How much, where, when.* */
    limitsHash: bytes32Schema,
    chainId: chainIdSchema,
    notBefore: unixSecondsSchema,
    notAfter: unixSecondsSchema,
    /** Monotonic per (safe, roleKey). A reissued Remit never collides with its ancestor. */
    nonce: uintStringSchema,
  })
  .strict()
  .refine((remit) => remit.notAfter > remit.notBefore, {
    message: "notAfter must be after notBefore",
    path: ["notAfter"],
  });

export type Remit = z.infer<typeof remitSchema>;

/**
 * A Remit together with the documents its hashes commit to.
 *
 * The hashes are the authority; the documents are what makes them checkable by a third
 * party. Both are committed, and `verify` re-derives one from the other rather than
 * trusting either.
 */
export const remitBundleSchema = z
  .object({
    remit: remitSchema,
    limits: limitsSchema,
    /** Filled in by P5: where the strategy source that `strategyHash` covers came from. */
    strategySource: z.string().min(1).optional(),
    /** Filled in by P3: the workflow definition that `workflowHash` covers. */
    workflowSource: z.string().min(1).optional(),
    /**
     * Owner signatures over `remitDigest`, from `eth_signTypedData_v4` (RM-5).
     *
     * Optional: an unsigned Remit still binds every hash the receipt chain needs, and the
     * on-chain preset is the real authority either way (cut line C5). What signatures add
     * is attribution — which owners agreed to this authority.
     */
    signatures: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).optional(),
  })
  .strict();

export type RemitBundle = z.infer<typeof remitBundleSchema>;
