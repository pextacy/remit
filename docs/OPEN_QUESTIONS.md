# OPEN QUESTIONS

Verification tasks that are blocked, and decisions the P0 pass forced but cannot make
alone. The rule that produced this file: when a value cannot be verified against a live
source, write the task down and stop — do not guess (CLAUDE.md §2.2).

Status as of **2026-09-14**, end of the P1 pass.

---

## Blocked on credentials

### OQ-1 — KeeperHub API surface confirmed only from source, not from the live service

PLAN.md 0.2 and 0.3 need a KeeperHub account, an API key, the MCP server connected, and
one trivial workflow executed by hand to produce a real `executionId`. None of that can be
done without someone creating the account.

What P0 did instead: read the route handlers in `KeeperHub/keeperhub` at commit
`f8c8f18c…` and recorded the request and response shapes in docs/VERIFIED.md §5. That is
an acceptable source, but it is not the same as a live 200.

**Unblocks when** someone creates the account and generates a key. Then:

1. `claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp`
2. Build one trivial workflow by hand and execute it.
3. Confirm the execute response really does carry `transactionHash`, and how often it is
   absent — KH-4 in PRD.md assumes polling is always required, and the source says it is
   not always. Record both shapes.
4. Confirm the `mcp:read` scope is what an API key gets by default.

Until then the bridge cannot be written against the real service, and every P3 estimate
carries this risk.

### OQ-6 — no funded key, so no Base Sepolia transaction hash yet

P1 is complete against a local Anvil fork of Base Sepolia: a real Safe, a real Roles v2
instance at the canonical mastercopy, the preset applied, value moved, and four refusals
with names. What it does not have is a **transaction hash on the public testnet**, because
that needs an EOA with Base Sepolia ETH and the Aave-listed test USDC, and no key exists
in this environment.

That is the difference between P1 being done and P1's exit gate being met. Everything is
in place to close it in minutes once there is a key:

1. Fund an EOA with Base Sepolia ETH, and get the Aave-listed USDC
   (`0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`, not Circle's testnet USDC).
2. Put three keys in `.env`: `SAFE_OWNER_1_PRIVATE_KEY`, `SAFE_OWNER_2_PRIVATE_KEY`,
   `AGENT_SIGNER_PRIVATE_KEY`, plus `SAFE_OWNER_3_ADDRESS` for the cold third owner and
   `ATTACKER_ADDRESS` for the out-of-preset probe.
3. Run, in order, against `--network base-sepolia`: `safe:deploy`, `roles:deploy`,
   `roles:build`, `roles:apply`, then `run exec --action approve`, `--action supply`, and
   `--action withdraw --violate --force`.

The scripts are network-agnostic; the fork path and the testnet path differ only in where
the signing authority comes from.

### OQ-2 — DoraHacks registration, Discord, office hours

PLAN.md 0.1 is unstarted and needs a human: register the project, join the KeeperHub
Discord, find the office-hours schedule, introduce the project in the builder channel.
Nothing in the build is blocked by this, but the submission is.

---

## Premise failures found by P0

These are not blockers. They are three load-bearing claims in PRD.md that are no longer
true, and each one changes what the week should build.

### OQ-3 — Issue #1241 is closed, and Safe support already shipped

PRD.md §2 and §5.10 are built on "KeeperHub has no first-class Safe support (open issue
#1241, milestone 2026 Q2)". At commit `f8c8f18c…`:

- `#1241` was **closed as completed on 2026-08-11**, with a maintainer comment: *"this one
  actually is already implemented"*.
- `plugins/safe/` exists upstream (`index.ts`, `credentials.ts`, `test.ts`,
  `steps/get-pending-transactions.ts`).
- Safe **and Zodiac Roles** execution is implemented: `lib/safe/roles-orchestrator.ts`,
  `lib/safe/zodiac-roles.ts`, `lib/safe/zodiac-contracts.ts`, the API surface under
  `app/api/user/safe/[safeId]/role/*`, a fork test at
  `tests/e2e/vitest/safe-roles-orchestrator-fork.test.ts`, and a user-facing docs page
  (`docs/wallet-management/safe.md`) describing `execTransactionWithRole` as a supported
  signer mode on Base.

So BP-1's four nodes are not a gap-filler; `safe.exec_with_role` in particular duplicates
something upstream already does. **A decision is needed before any code goes into
`packages/keeperhub-safe/`.** The options, in the order P0 would rank them:

1. **Find the actual remaining gap and build that.** The upstream Roles path is wired to
   KeeperHub's own org-derived role key and its own preset wizard. A *preflight* node —
   simulate `execTransactionWithRole` with `shouldRevert=true` and return the decoded
   `Status` instead of a hex blob — does not appear to exist upstream, and it is exactly
   G2. Narrow, useful, and honest about what is already there.
2. **Pick a different open issue.** 108 issues are open; the bounty asks for the best
   feature, not specifically Safe.
3. **Drop the bounty BUIDL** and spend the time on the main track.

### OQ-4 — Upstream wants an accepted issue before the pull request

`CONTRIBUTING.md` and `ISSUES.md` are explicit: anything that changes behaviour needs an
issue first, and the maintainer applies an `accepted` label before the pull request is
written. PLAN.md 1.9 ("open the bounty PR as a draft on Monday") inverts that order, and
under the current policy it reads as the thing the policy was written to stop.

Revised order for P7, whichever option OQ-3 picks: open the issue on **Monday morning**,
state the reason, scope and plan in it, and write the code while waiting for the label.
The public iteration the plan wants still happens — in the issue rather than in a PR.

### OQ-5 — `txHash` polling, and the provenance claim

Two smaller drifts:

- `#1784` is closed, and the execute response now carries `transactionHash` and
  `transactionLink` when they are known. KH-4's strict-correlation polling is still the
  right fallback, but "the execute response does not return it" is no longer the
  submission's honest answer (PRD.md §8). Re-word once OQ-1 confirms the live behaviour.
- Almanak's own `ExecutionResult` already carries `submission_provenance` and
  `execution_plan_hash`. Read what those actually contain during P5 before repeating
  "provenance receipts do not exist anywhere today" (PRD.md §7) in front of a judge who
  may have read the proto.

---

## Settled by P0 — kept for the record

| # | Question | Answer |
|---|---|---|
| AL-2 | Does Almanak expose an execution seam we can implement without forking? | **Yes.** gRPC `ExecutionService`; subclass `ExecutionServiceServicer`, point the strategy at us with `ALMANAK_GATEWAY_HOST`/`PORT`. docs/VERIFIED.md §6. Cut line C6 is not needed |
| — | Is the deployed Roles mastercopy 2.0.0? | No, **2.1.0**. KeeperHub's own constant file says 2.0.0 in a comment; the mastercopy registry and the chain say 2.1.0 |
| — | Which USDC on Base Sepolia? | The Aave-listed one, `0xba50Cd2A…`, not Circle's testnet USDC |
