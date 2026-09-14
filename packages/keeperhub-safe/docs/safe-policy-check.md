---
title: "Check Role Policy"
description: "Ask the Zodiac Roles modifier whether a call would be allowed, before sending it."
---

# Check Role Policy

When your organization routes workflow writes through a Safe with a Zodiac Roles modifier,
every write goes out as `rolesModifier.execTransactionWithRole(...)`. The modifier checks
the call against the role's allowlist of protocols, functions and per-token allowances
before forwarding it to the Safe.

If the call is outside the role, the modifier reverts. That is the system working — but by
then the transaction has been broadcast and the gas is gone, and the reason arrives in the
execution log rather than in the workflow.

**Check Role Policy** asks the same question first. It simulates the real call —
`execTransactionWithRole` with `shouldRevert = true`, via `eth_call`, from the delegate
EOA — and reports whether the role would allow it. No transaction is sent and no gas is
spent, whatever the answer.

## When to use it

Put it before a write node when:

- the workflow writes to a protocol whose allowlist entry might have been tightened
- an allowance may have been consumed by an earlier run
- a branch should take a different path when the role would refuse
- you want the refusal in the workflow's own output rather than in a failed execution

## Inputs

| Field | Required | Description |
|---|---|---|
| `contractAddress` | yes | The contract the next node intends to call |
| `callData` | yes | The calldata that node would send, `0x`-prefixed |
| `value` | no | Native value in wei, as a decimal string. Defaults to `0` |
| `network` | yes | The chain to check on |

## Outputs

| Field | Description |
|---|---|
| `allowed` | Whether the role would allow the call |
| `reason` | A named reason when it would not |
| `revertKind` | Structured classification, e.g. `role-condition-violation` |
| `status` | The modifier's `Status` label on a condition refusal, e.g. `ParameterNotAllowed` |
| `refusedByRole` | `true` when the role refused; `false` when the role allowed it and the call would fail anyway |
| `gasEstimate` | Gas the call would consume if it were sent |

A refusal is a **successful** step with `allowed: false`. The node does not fail, because
what to do about a refusal is the workflow author's decision — branch, alert, stop — and a
step that threw would take that choice away.

`refusedByRole` is the field to branch on. `false` with `allowed: false` means the policy
is fine and something else is wrong — an exhausted allowance, an empty balance — which is
a different problem with a different fix.

## Requirements

The organization must be signing through a Zodiac Roles modifier on the chain being
checked (`safe-role` signer mode). On an `eoa` or plain `safe` organization there is no
role policy to check, and the step says so rather than reporting `allowed: true`.

## How it differs from simulation

The execute API's `simulate` flag runs the **inner** call from the organization's EOA. Its
own source notes the limitation: for organizations that route through a Safe, the
simulated `msg.sender` is the EOA rather than the Safe, and the Roles modifier is not in
the simulated path at all.

This step simulates the **outer** call instead, so the preflight and the broadcast take
the same path through the same contract, with the same `msg.sender` at the target.
