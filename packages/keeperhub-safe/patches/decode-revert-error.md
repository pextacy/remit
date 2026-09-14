# A second, smaller fix: the Roles error list does not match the deployed modifier

Found while writing the tests for **Check Role Policy**, and worth its own review even if
that node is not wanted.

`lib/web3/decode-revert-error.ts` declares the Zodiac Roles custom errors it can decode:

```ts
const ROLE_ERROR_FRAGMENTS: string[] = [
  "error ConditionViolation(uint8 status, bytes32 paramOrAllowanceKey)",
  "error UnauthorizedAccount(address account)",
  "error UnacceptableMultiSendOffset()",
  "error AlreadyAssigned()",
  "error InvalidArrayConfiguration()",
];
```

Four of those five are not errors the deployed modifier can emit, and three errors it
emits constantly are missing.

## What the deployed mastercopy actually declares

Roles **2.1.0** at `0x9646fDAD06d3e24444381f44362a3B0eB343D337` — the address
`lib/safe/zodiac-contracts.ts` installs, and the one deployed on every chain in
`ROLES_SUPPORTED_CHAIN_IDS`. Source: `packages/evm/mastercopies.json` in
`gnosisguild/zodiac-modifier-roles`, entry `Roles` → `2.1.0`, which carries the deployed
ABI verbatim:

```
AlreadyDisabledModule(address)   InvalidPageSize()
AlreadyEnabledModule(address)    MalformedMultiEntrypoint()
ArraysDifferentLength()          ModuleTransactionFailed()
CalldataOutOfBounds()            NoMembership()
ConditionViolation(uint8,bytes32)  NotAuthorized(address)
FunctionSignatureTooShort()      OwnableUnauthorizedAccount(address)
HashAlreadyConsumed(bytes32)     SetupModulesAlreadyCalled()
```

`UnauthorizedAccount`, `UnacceptableMultiSendOffset`, `AlreadyAssigned` and
`InvalidArrayConfiguration` are not among them.

## What it costs today

Observed against the current list:

| Revert | `classifyRevert` returns |
|---|---|
| `ConditionViolation(7, …)` | `role-condition-violation`, `ParameterNotAllowed` ✓ |
| `NoMembership()` | `{ kind: "unknown" }` |
| `ModuleTransactionFailed()` | `{ kind: "unknown" }` |

`NoMembership()` is what the modifier returns when a delegate is **not a member of the
role** — the revert every org sees the moment a role is revoked, or when a Safe is
installed but the automation EOA was never assigned. It is the single most likely Roles
failure a user will hit, and it currently reports as `unknown`.

`ModuleTransactionFailed()` is the other common one: the role *allowed* the call and the
inner call failed. Those two are opposite problems with opposite fixes, and today both
arrive as `unknown`.

## The fix

```ts
const ROLE_ERROR_FRAGMENTS: string[] = [
  // Verified against the deployed Roles 2.1.0 mastercopy ABI
  // (gnosisguild/zodiac-modifier-roles, packages/evm/mastercopies.json).
  "error ConditionViolation(uint8 status, bytes32 paramOrAllowanceKey)",
  "error NoMembership()",
  "error NotAuthorized(address account)",
  "error ModuleTransactionFailed()",
  "error CalldataOutOfBounds()",
  "error FunctionSignatureTooShort()",
  "error MalformedMultiEntrypoint()",
  "error HashAlreadyConsumed(bytes32 hash)",
  "error ArraysDifferentLength()",
];
```

and in `classifyRoleError`:

```ts
  if (decoded.name === "NotAuthorized") {
    return { kind: "role-not-authorized", account: String(decoded.args[0]) };
  }
  if (decoded.name === "NoMembership") {
    return { kind: "role-not-authorized" };
  }
```

`RevertKind` needs no new variants: `role-not-authorized` already has an optional
`account`, and `ModuleTransactionFailed` is correctly a `contract-custom` — the role
allowed the call, so it is not a role refusal, and callers branching on `kind` should see
that difference.

## Why this is separate from the node

The node works either way; it reports `refusedByRole: false` for a `NoMembership()` today
because the classifier cannot name it, which is the wrong answer for the user and the
right answer given what it was told. The fix belongs in the shared decoder because every
existing caller — `write-contract-core`, `transfer-token-core`, the execution service —
has the same blind spot.

Happy to split this into its own issue and PR if that is easier to review.
