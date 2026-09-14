# Pull request draft — open only after the issue is accepted

**Do not open this until the issue in `ISSUE.md` has the `accepted` label.**
`CONTRIBUTING.md` asks for the issue first, and `ISSUES.md` explains what it has cost
contributors when that order is reversed.

---

**Title:** `feat: #<issue> check role policy before a Safe+Roles workflow spends gas`

Closes #<issue>.

## What this adds

One action on the existing `safe` plugin: **Check Role Policy**. It simulates the real
outer call — `execTransactionWithRole(to, value, data, Call, roleKey, shouldRevert=true)`
via `eth_call`, from `signerMode.delegateAddress` — and reports whether the role would
allow it. No transaction is sent, and no gas is spent whatever the answer.

## Why

`lib/execute/simulate.ts` already says it: for orgs that route writes through a Safe, the
simulation reflects the EOA sending the call, not the Safe, and it does not mirror
Safe-routed `msg.sender` semantics. For a `safe-role` org the Roles modifier is not in the
simulated path at all, so a call the role forbids simulates clean and reverts on chain —
correctly decoded by `classifyRevert`, after the gas is gone.

This puts the existing pieces together before the write instead of after it:
`buildExecTransactionWithRoleCalldata`, `resolveSignerMode`, `classifyRevert`.

## Files

- `plugins/safe/steps/policy-check.ts` — the step. `"use step"`, `runPluginStep`,
  `maxRetries = 0`, exports only the step function, `_integrationType` and types.
- `plugins/safe/steps/policy-check-core.ts` — shared logic, per the core-file pattern.
- `plugins/safe/index.ts` — one action entry beside `getPendingTransactionsAction`.
- `docs/workflows/safe-policy-check.md` — docs page.
- `tests/unit/safe-policy-check.test.ts`, and a fork test beside
  `tests/e2e/vitest/safe-roles-orchestrator-fork.test.ts`.

## Behaviour

- A refusal is a **successful step** with `allowed: false`, so the workflow author can
  branch on it. A step that threw would take that choice away and retry a decision the
  chain has already made — hence `maxRetries = 0`.
- An unreachable RPC returns `success: false`, not a policy answer. Reporting
  `allowed: true` would turn an outage into a green light.
- A non-`safe-role` org is told that there is no role policy to check, rather than being
  told the call is allowed.
- `refusedByRole` separates "the role said no" from "the role said yes and the call would
  fail anyway" — an exhausted allowance is a different problem with a different fix.

## Output of a real run

<!--
Paste the output of the fork test and of a workflow run against Base Sepolia here: one
`allowed: true`, one refusal with a named `Status`, and the gas figure. A description of
behaviour is not evidence of it.
-->

## Notes for review

The step deliberately does not retry, does not cache, and does not consult any database:
a policy answer is a point-in-time reading of on-chain state, and a stale one is worse
than none.
