/**
 * Zodiac Roles v2 `Status` — the enum carried by `ConditionViolation(uint8,bytes32)`.
 *
 * Source: gnosisguild/zodiac-modifier-roles, `packages/evm/contracts/PermissionChecker.sol`
 * lines 728-764, at tag `zodiac-roles-sdk-v4.1.3` (commit 820e5bc9). That package is
 * version 2.1.0, which is the mastercopy version deployed at `ROLES_MASTERCOPY`, so the
 * ordinals below match the chain. Verified 2026-09-13.
 *
 * Order is the ABI encoding. Never re-order, never insert. G2 turns the `uint8` in a
 * revert into one of these names; an undecoded `0x…` is a failed requirement
 * (PRD.md G2-2).
 */
export const ROLES_STATUS = [
  "Ok",
  "DelegateCallNotAllowed",
  "TargetAddressNotAllowed",
  "FunctionNotAllowed",
  "SendNotAllowed",
  "OrViolation",
  "NorViolation",
  "ParameterNotAllowed",
  "ParameterLessThanAllowed",
  "ParameterGreaterThanAllowed",
  "ParameterNotAMatch",
  "NotEveryArrayElementPasses",
  "NoArrayElementPasses",
  "ParameterNotSubsetOfAllowed",
  "BitmaskOverflow",
  "BitmaskNotAllowed",
  "CustomConditionViolation",
  "AllowanceExceeded",
  "CallAllowanceExceeded",
  "EtherAllowanceExceeded",
] as const;

export type RolesStatus = (typeof ROLES_STATUS)[number];

/** Human-readable reason per status, taken from the natspec on the enum members. */
export const ROLES_STATUS_REASON: Readonly<Record<RolesStatus, string>> = {
  Ok: "no violation",
  DelegateCallNotAllowed: "role not allowed to delegate call to target address",
  TargetAddressNotAllowed: "role not allowed to call target address",
  FunctionNotAllowed: "role not allowed to call this function on target address",
  SendNotAllowed: "role not allowed to send to target address",
  OrViolation: "or condition not met",
  NorViolation: "nor condition not met",
  ParameterNotAllowed: "parameter value is not equal to allowed",
  ParameterLessThanAllowed: "parameter value less than allowed",
  ParameterGreaterThanAllowed: "parameter value greater than maximum allowed by role",
  ParameterNotAMatch: "parameter value does not match",
  NotEveryArrayElementPasses:
    "array elements do not meet allowed criteria for every element",
  NoArrayElementPasses:
    "array elements do not meet allowed criteria for at least one element",
  ParameterNotSubsetOfAllowed: "parameter value not a subset of allowed",
  BitmaskOverflow: "bitmask exceeded value length",
  BitmaskNotAllowed: "bitmask not an allowed value",
  CustomConditionViolation: "custom condition violated",
  AllowanceExceeded: "allowance exceeded",
  CallAllowanceExceeded: "call allowance exceeded",
  EtherAllowanceExceeded: "ether allowance exceeded",
};
