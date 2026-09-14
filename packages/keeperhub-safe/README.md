# keeperhub-safe — the bounty package

A contribution to `KeeperHub/keeperhub`: one action on their existing `safe` plugin that
answers *"would the Roles modifier allow this call?"* before a workflow spends gas finding
out.

## What P0 found, and why this is not the plugin the PRD described

`PRD.md` §5.10 asks for four nodes — `safe.read_state`, `safe.policy_check`,
`safe.exec_with_role`, `safe.propose` — on the premise that KeeperHub has no first-class
Safe support and that issue #1241 is open. Verification found otherwise
(docs/OPEN_QUESTIONS.md OQ-3):

- **#1241 was closed as completed** on 2026-08-11. A maintainer: *"this one actually is
  already implemented"*.
- `plugins/safe/` exists upstream, and so does the whole Zodiac Roles path:
  `lib/safe/roles-orchestrator.ts`, `lib/safe/zodiac-roles.ts`, the API surface under
  `app/api/user/safe/[safeId]/role/*`, a fork test, and a user-facing docs page.
- `lib/web3/decode-revert-error.ts` already decodes the modifier's custom errors and
  carries labels for its `Status` enum.

Building the four nodes anyway would have meant re-implementing working code and opening a
pull request against a closed issue. So the contribution narrowed to the thing that is
genuinely missing, and upstream says what it is in its own source — see `ISSUE.md`.

## What is here

```
steps/policy-check.ts        → plugins/safe/steps/policy-check.ts
steps/policy-check-core.ts   → plugins/safe/steps/policy-check-core.ts
index.action.ts              → one entry to add in plugins/safe/index.ts
docs/safe-policy-check.md    → docs/workflows/safe-policy-check.md
ISSUE.md                     → the issue to file first
PR.md                        → the pull request description
```

Self-contained by construction: nothing here imports `@remit/core` or anything else from
this repository. Every import is an upstream module, and each one was checked to exist at
commit `f8c8f18c754ccbca481774a1c3c0fdf71e282e96` (docs/VERIFIED.md §17).

`index.action.ts` is an entry to **add**, not a file to copy over theirs. `plugins/safe/index.ts`
already registers `getPendingTransactionsAction`; a plugin that overwrote it would delete a
working action, and a reviewer would be right to reject it.

## What is not here

**Tests.** `BP-4` asks for unit tests plus a Base Sepolia fork test, and they are the
remaining work before this can be opened as a pull request — `CONTRIBUTING.md` expects
them and the change is not mergeable without them. They were left out under a standing
instruction for this build, not because the requirement went away. The issue draft names
the files they belong in.

**A posted issue or PR.** Upstream requires an accepted issue before a pull request
(`ISSUES.md`), and posting either is an outward-facing action for the repository owner.
Both drafts are written and ready.

## The same capability, in this repository

Remit's G2 is this check, and has been running since P3: `pnpm --filter ops propose` and
`remit serve` both preflight `execTransactionWithRole` with `shouldRevert = true` before
anything is sent. The upstream version is the same idea expressed in their conventions,
against their signer resolver and their revert classifier.
