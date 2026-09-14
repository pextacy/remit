# Issue draft — to be filed before any pull request

`CONTRIBUTING.md` and `ISSUES.md` are explicit: anything that changes behaviour needs an
issue first, and a maintainer applies the `accepted` label before the pull request is
written. This is that issue, ready to post. **It has not been posted** — that is an
outward-facing action for the repository owner to take.

The three parts `ISSUES.md` asks for are the three headings below.

---

**Title:** Safe + Roles workflows have no way to ask "would this call be allowed?" before
they spend gas

## The reason

`lib/execute/simulate.ts` documents its own limitation:

> **Known limitation:** `from` is resolved via `getOrganizationWalletAddress` (the org's
> EOA / smart account address). Orgs that route writes through a Safe will produce a
> simulation that reflects the EOA sending the call, not the Safe. This still catches most
> config bugs (bad ABI, bad args, allowance mismatches) but does not perfectly mirror
> Safe-routed msg.sender semantics.

For a `safe-role` organization that leaves two gaps:

1. The simulated `msg.sender` is the delegate EOA, not the Safe, so allowance and balance
   checks inside the target contract are answered about the wrong account.
2. The Roles modifier is not in the simulated path at all. A call the role forbids
   simulates clean, is broadcast, and reverts on chain. The refusal is decoded afterwards
   by `classifyRevert` — accurately, and after the gas is gone.

The pieces to close it already exist: `buildExecTransactionWithRoleCalldata`,
`resolveSignerMode`, and a `classifyRevert` that already understands the modifier's
`Status` enum. What is missing is a node that puts them together before the write rather
than after it.

## The scope

One new action on the existing `safe` plugin: **Check Role Policy**
(`safe` / `policy-check`).

It simulates `execTransactionWithRole(to, value, data, Call, roleKey, shouldRevert=true)`
with `eth_call`, from `signerMode.delegateAddress`, against
`signerMode.rolesModifierAddress`, and reports whether the role would allow the call. No
transaction is sent.

Out of scope: changing `lib/execute/simulate.ts`, changing how writes are routed, and
anything to do with policy *installation*, which `POST .../role/simulate` already covers.

## The plan

- `plugins/safe/steps/policy-check.ts` — the step (`"use step"`, `runPluginStep`,
  `maxRetries = 0`, exports only the step function, `_integrationType` and types).
- `plugins/safe/steps/policy-check-core.ts` — the shared logic, per the core-file pattern.
- One action entry pushed onto the `safe` integration in `plugins/safe/index.ts`, beside
  `getPendingTransactionsAction`.
- `docs/workflows/safe-policy-check.md` — a docs page.
- `tests/unit/safe-policy-check.test.ts` — ten unit tests, written and passing against a
  clone of this repository, plus a fork test alongside
  `tests/e2e/vitest/safe-roles-orchestrator-fork.test.ts`.

Behaviour worth agreeing before code review:

- **A refusal is a successful step** with `allowed: false`, not a thrown error. What to do
  about a refusal is the workflow author's decision, and a step that threw would take that
  choice away and retry a decision the chain has already made.
- **An unreachable RPC is neither.** It returns `success: false` rather than guessing:
  reporting `allowed: true` would turn an outage into a green light, and `allowed: false`
  would stop a workflow the role would have permitted.
- **A non-`safe-role` organization is told so**, rather than getting `allowed: true` for a
  policy that does not exist.

Happy to adjust any of those before writing the tests.
