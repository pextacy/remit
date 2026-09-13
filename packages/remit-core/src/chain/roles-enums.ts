/**
 * The Roles v2 enums, as ordinals on the wire.
 *
 * Source: gnosisguild/zodiac-modifier-roles, `packages/evm/contracts/Types.sol`, tag
 * `zodiac-roles-sdk-v4.1.3`, package version 2.1.0 — the version deployed at
 * `ROLES_MASTERCOPY`. Verified 2026-09-13.
 *
 * Ordinals are the ABI encoding. Never re-order.
 */

/**
 * `ConditionFlat.paramType`. The 2.1.0 source calls this type `AbiType`; older Roles
 * documentation calls the same field `ParameterType`. Same wire layout.
 */
export const AbiType = {
  None: 0,
  Static: 1,
  Dynamic: 2,
  Tuple: 3,
  Array: 4,
  /** A whole calldata blob: selector plus arguments. The root of a function scope. */
  Calldata: 5,
  AbiEncoded: 6,
} as const;
export type AbiTypeValue = (typeof AbiType)[keyof typeof AbiType];

/**
 * `ConditionFlat.operator`. The gaps are `_PlaceholderNN` members in the source; they
 * exist so the numbering stays stable, and they are kept here for the same reason.
 */
export const Operator = {
  /** Always passes. A parameter we deliberately do not constrain. */
  Pass: 0,
  And: 1,
  Or: 2,
  Nor: 3,
  /** Structural: this node's children describe the parameters, in order. */
  Matches: 5,
  ArraySome: 6,
  ArrayEvery: 7,
  ArraySubset: 8,
  /**
   * Equal to the avatar — the Safe — without naming its address in the condition.
   * This is the operator that pins `onBehalfOf` and `to`, and therefore the single
   * line that makes exfiltration structurally impossible (PRD.md G4-2).
   */
  EqualToAvatar: 15,
  EqualTo: 16,
  GreaterThan: 17,
  LessThan: 18,
  SignedIntGreaterThan: 19,
  SignedIntLessThan: 20,
  Bitmask: 21,
  Custom: 22,
  WithinAllowance: 28,
  EtherWithinAllowance: 29,
  CallWithinAllowance: 30,
} as const;
export type OperatorValue = (typeof Operator)[keyof typeof Operator];

/**
 * `ExecutionOptions`. The agent role gets `None`: no native value, no delegatecall
 * (PRD.md G4-3). `DelegateCall` on an agent role would hand over the Safe itself.
 */
export const ExecutionOptions = {
  None: 0,
  Send: 1,
  DelegateCall: 2,
  Both: 3,
} as const;
export type ExecutionOptionsValue =
  (typeof ExecutionOptions)[keyof typeof ExecutionOptions];

/** `TargetAddress.clearance`, as returned when reading a scope back off chain. */
export const Clearance = {
  None: 0,
  Target: 1,
  Function: 2,
} as const;
export type ClearanceValue = (typeof Clearance)[keyof typeof Clearance];

/** Safe `Operation` for module calls. Remit never sends `DelegateCall`. */
export const Operation = {
  Call: 0,
  DelegateCall: 1,
} as const;
export type OperationValue = (typeof Operation)[keyof typeof Operation];

/** One node of a flattened condition tree, as `scopeFunction` takes it. */
export type ConditionFlat = {
  /** Index of this node's parent. The root is its own parent, at index 0. */
  readonly parent: number;
  readonly paramType: AbiTypeValue;
  readonly operator: OperatorValue;
  /** 32 bytes for a `Static` comparison; `0x` for operators that take no value. */
  readonly compValue: `0x${string}`;
};
