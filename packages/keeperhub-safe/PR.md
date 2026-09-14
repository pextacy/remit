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

## What was run

```
npx tsgo --noEmit                              exit 0, whole repo
pnpm discover-plugins                          registers safe/policy-check → policyCheckStep
npx vitest run tests/unit/safe-policy-check    10 passed
npx vitest run tests/unit                      23,276 passed
```

The two unit files that fail in that last run — `use-persisted-nav-state` and
`welcome-status` — fail identically on a pristine checkout of this commit, so they are not
this change.

<!--
Before opening: add the output of the fork test against Base Sepolia, and of a workflow run
using the node — one `allowed: true` with its gas figure, one refusal with a named Status.
A description of behaviour is not evidence of it.
-->

## A second finding, while testing

`lib/web3/decode-revert-error.ts` cannot decode `NoMembership()` — the revert every org
sees the moment a role is revoked. Four of its five Roles error fragments are errors the
deployed 2.1.0 mastercopy cannot emit, and the three it emits most often are missing.
Written up separately; happy to split it into its own issue and PR.

## Notes for review

The step deliberately does not retry, does not cache, and does not consult any database:
a policy answer is a point-in-time reading of on-chain state, and a stale one is worse
than none.
