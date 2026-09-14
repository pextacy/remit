# OPEN QUESTIONS

Verification tasks that are blocked, and decisions the P0 pass forced but cannot make
alone. The rule that produced this file: when a value cannot be verified against a live
source, write the task down and stop — do not guess (CLAUDE.md §2.2).

Status as of **2026-09-14**, end of the P9 pass.

---

## Blocked on credentials

### OQ-1 — KeeperHub API surface confirmed only from source, not from the live service

PLAN.md 0.2 and 0.3 need a KeeperHub account, an API key, the MCP server connected, and
one trivial workflow executed by hand to produce a real `executionId`. None of that can be
done without someone creating the account.

What P0 did instead: read the route handlers in `KeeperHub/keeperhub` at commit
`f8c8f18c…` and recorded the request and response shapes in docs/VERIFIED.md §5. That is
an acceptable source, but it is not the same as a live 200.

**What is already built against it.** `packages/remit-bridge/src/remit_bridge/keeperhub.py`
implements both execution routes, the two status vocabularies, strict `executionId`
correlation and `ReceiptUnresolvable`. `remit run` goes G1 → KeeperHub → receipt and stops
with `CONFIG_MISSING` when there is no key — it does not fall back to a local signer,
because a fallback would make KH-1 false in exactly the case where it matters. The first
run against the live service is therefore a configuration step, not a build step.

**Unblocks when** someone creates the account and generates a key. Then:

1. `claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp`
2. Build one trivial workflow by hand and execute it.
3. Confirm the execute response really does carry `transactionHash`, and how often it is
   absent — KH-4 in PRD.md assumes polling is always required, and the source says it is
   not always. Record both shapes.
4. Confirm the `mcp:read` scope is what an API key gets by default, and that
   `/api/workflow/{id}/execute` accepts an API key rather than only an OAuth token with
   `mcp:write` — the route reads both, and which one a `kh_` key satisfies decides whether
   the workflow path or the direct-execution path is the one that ships.
5. Check what a workflow with one write node actually returns in `transactionHashes`. If
   it can return more than one, the workflow definition needs splitting, because
   `resolve_tx_hash` refuses to guess which hash a receipt covers.

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

### OQ-8 — the strategy-driven transaction still needs KeeperHub

P5's exit gate asks for a transaction hash produced by the strategy through the adapter.
Everything up to the submission is done and observed on a fork: the strategy decides, its
intent crosses Almanak's own client into `remit serve`, G1 and G2 both run, and a receipt
is written. `Execute` with `dry_run=False` then stops at the same wall as everything else
— KeeperHub is the only path that submits, and there is no account (OQ-1).

It is deliberately not routed around. The bridge has no local-signer path and CI fails the
build if one appears; a fork-only fallback would make KH-1 false in exactly the case where
it matters.

**Unblocks with OQ-1**, and needs nothing else: `remit serve` with `KEEPERHUB_API_KEY` set,
then `python -m remit_bridge.drive --network base-sepolia` without `--dry-run`.

### OQ-9 — the mainnet proof transaction

The submission requirement — one transaction on Base mainnet, through KeeperHub, out of
the Safe — is not met. It needs money and credentials, not code:

1. ~0.003 ETH on Base across the owner and agent EOAs (the whole sequence is 1.87M gas,
   about 0.0000112 ETH at current prices — the headroom is for comfort, not need).
2. 30 USDC on Base in a wallet you control, to fund the Safe.
3. A KeeperHub API key (OQ-1), because the product path submits through KeeperHub and
   there is no fallback.

Everything else is done and rehearsed against a fork of Base mainnet: docs/MAINNET.md is
the runbook, `mainnet:preflight` is the go/no-go, and the only check that fails today is
the KeeperHub one.

**Do not approximate this.** A testnet hash presented as the mainnet proof, or a fork hash
linked to Basescan, is the one failure that would deserve to sink the submission. The
receipts from the rehearsal are gitignored for exactly that reason: they name a Safe that
does not exist on the public chain, and a reader cannot tell that from the file.

### OQ-10 — the demo video, and the third-party verification

Two things left that are somebody's time rather than somebody's code:

**The video.** `docs/DEMO.md` is the script: three minutes, timed, every command working
today against a fork, and the questions to have answers ready for. Recording it needs a
screen and a voice. Do it on **Thursday** — the day you think you have spare is the day
the RPC key expires.

**Acceptance criterion 3, the human half.** `remit verify` has been run from a fresh
`git clone` with `pnpm install` and nothing else, and it catches an edited receipt, a
deleted one, and an edited one re-sealed with a valid hash. What has not happened is
*somebody who did not write it* running it. That is thirty seconds of another person's
time and it is worth spending: the claim is that a stranger can check the chain, and the
only way to know is to hand it to one.

### OQ-2 — DoraHacks registration, Discord, office hours

PLAN.md 0.1 is unstarted and needs a human: register the project, join the KeeperHub
Discord, find the office-hours schedule, introduce the project in the builder channel.
Nothing in the build is blocked by this, but the submission is.

### OQ-7 — `workflowHash` binds a document KeeperHub has not seen

A Remit binds `workflowHash`, the hash of the workflow definition that is allowed to run.
P2 needs a real document to hash, and OQ-1 means the registered shape cannot be checked,
so `ops/workflows/exec-with-role.workflow.json` is **our own declaration** of what must
run: four steps, their purposes, and the inputs they take. It is hashed with the canonical
serialiser, so reformatting it does not change the binding.

What P3 has to do about it: register the workflow, record the id KeeperHub assigns, and
compare its canonical definition with this file. If they differ — and they probably will,
because KeeperHub's node schema is its own — the Remit is reissued against the registered
hash. A Remit is cheap; a binding that points at a document nobody executes is not.

Until then, treat `workflowHash` in any committed Remit as provisional, and do not put one
in front of a judge as evidence of what ran.

---

## Premise failures found by P0

These are not blockers. They are three load-bearing claims in PRD.md that are no longer
true, and each one changes what the week should build.

### OQ-3 — Issue #1241 is closed, and Safe support already shipped — **decided**

**Decision taken in P7: option 1.** The contribution narrowed to the gap upstream
documents in its own source, and the code is written and verified inside a clone of their
repository (docs/VERIFIED.md §17). What remains before it can be opened: unit tests and a
fork test (BP-4), then the issue, then — once accepted — the pull request.

The original finding, kept because it is why the shape changed:


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
