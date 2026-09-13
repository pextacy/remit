/**
 * The EIP-712 typed data for a Remit, and its digest (DOCS.md §2.1).
 *
 * `verifyingContract` is the Safe, because the Safe is the authority being delegated
 * from. There is no on-chain verification of the signature and that is deliberate: the
 * Remit is an off-chain declaration of intent, and the on-chain truth is the Roles
 * preset. A Remit cannot grant authority the preset does not already grant. It can only
 * narrow. That is why this project needs no custom contract.
 */
import { type Hex, hashTypedData, type TypedDataDomain } from "viem";
import type { Remit } from "../schema/remit.js";

export const REMIT_DOMAIN_NAME = "Remit" as const;
export const REMIT_DOMAIN_VERSION = "1" as const;

/**
 * The struct, field for field and in order. The order is part of the type hash: changing
 * it changes every digest ever produced, so this array is append-only in practice.
 */
export const REMIT_TYPES = {
  Remit: [
    { name: "strategyHash", type: "bytes32" },
    { name: "workflowHash", type: "bytes32" },
    { name: "safe", type: "address" },
    { name: "rolesModifier", type: "address" },
    { name: "roleKey", type: "bytes32" },
    { name: "limitsHash", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "notBefore", type: "uint64" },
    { name: "notAfter", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The literal type string EIP-712 hashes to produce the type hash. Useful for checking. */
export const REMIT_TYPE_STRING =
  "Remit(bytes32 strategyHash,bytes32 workflowHash,address safe,address rolesModifier,bytes32 roleKey,bytes32 limitsHash,uint256 chainId,uint64 notBefore,uint64 notAfter,uint256 nonce)" as const;

export function remitDomain(remit: Remit): TypedDataDomain {
  return {
    name: REMIT_DOMAIN_NAME,
    version: REMIT_DOMAIN_VERSION,
    chainId: remit.chainId,
    verifyingContract: remit.safe,
  };
}

/** The typed-data payload, ready for `eth_signTypedData_v4`. */
export function remitTypedData(remit: Remit) {
  return {
    domain: remitDomain(remit),
    types: REMIT_TYPES,
    primaryType: "Remit" as const,
    message: {
      strategyHash: remit.strategyHash,
      workflowHash: remit.workflowHash,
      safe: remit.safe,
      rolesModifier: remit.rolesModifier,
      roleKey: remit.roleKey,
      limitsHash: remit.limitsHash,
      chainId: BigInt(remit.chainId),
      notBefore: BigInt(remit.notBefore),
      notAfter: BigInt(remit.notAfter),
      nonce: BigInt(remit.nonce),
    },
  };
}

/**
 * `remitHash`. Deterministic, and reproducible from the committed documents by anyone
 * (PRD.md RM-2).
 */
export function remitDigest(remit: Remit): Hex {
  return hashTypedData(remitTypedData(remit));
}
