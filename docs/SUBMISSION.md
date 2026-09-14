# Submission draft

For the DoraHacks form. Two BUIDLs, as the rules require: the main track and the bounty.
Answers are written to be true on the day they are pasted — check the three marked
**[fill]** first, because each one is currently blocked and each one is a hard requirement.

---

## BUIDL 1 — main track, *Best Integration into a Live Project*

**Project name:** Remit

**One line:** An agent may remit only within its remit — bounded-authority execution for
onchain AI agents, with a provenance receipt for every attempt.

### Which project did you integrate with, and what does the integration do?

Almanak, the live AI quant platform. Remit makes KeeperHub the execution layer for
Almanak strategies operating out of a Safe.

The integration is at Almanak's own execution seam, not beside it: Remit implements their
gRPC `ExecutionService` — `CompileIntent`, `Execute`, `GetTransactionStatus` — from the
SDK's own generated stubs, at a pinned version (`almanak==2.28.0`). A strategy is pointed
at it with `ALMANAK_GATEWAY_HOST`/`PORT`, which is Almanak's own precedence ladder. There
is no fork of the SDK and no patched strategy; the one in `strategies/` is an unmodified
`IntentStrategy` with no Remit imports, which would run unchanged against Almanak's
platform gateway.

What happens to an intent once it arrives: a signed Remit bounds what it may do, KeeperHub
executes it, and a Zodiac Roles v2 preset enforces the boundary on chain. Every run
produces a hash-chained receipt linking the strategy version to the transaction hash.

### Which KeeperHub surfaces did you use?

The workflow execution API for submission, with workflows registered in advance and
invoked by id — no Remit code has a raw-send path, and CI fails the build if one appears.
The execution status route for transaction-hash resolution, correlated strictly on
`executionId`; an ambiguous correlation raises rather than writing a hash we are not sure
of. Notification nodes for operator alerts. Plus a contribution back upstream: a
policy-check node for their existing Safe plugin.

### Testnet or mainnet?

**[fill]** Both is the intent: development and the live demo on Base Sepolia, proof
transactions on Base mainnet, with a 5 USDC per-transaction and 25 USDC daily cap enforced
in both the Remit and the Roles preset. As of writing, the public transactions are not
done — see "what still breaks". The full mainnet sequence is rehearsed against a fork of
Base mainnet and the runbook with measured gas is `docs/MAINNET.md`.

### Link to a transaction executed through KeeperHub

**[fill]** — blocked on a KeeperHub API key and a funded key. `docs/OPEN_QUESTIONS.md`
OQ-1, OQ-6, OQ-9. Do not submit a fork hash or a testnet hash in this field.

### Source code

**[fill]** the repository URL.

### Demo video

**[fill]** — the script is `docs/DEMO.md`; record it Thursday.

### What still breaks or is unfinished?

Answered candidly, because the brief says it has never hurt a submission:

- **No public transaction yet.** Everything runs against forks of Base and Base Sepolia —
  real contracts, real state — and the mainnet sequence is rehearsed end to end. What is
  missing is a funded key and a KeeperHub account, not code.
- **The KeeperHub client has never spoken to KeeperHub.** It is written against their
  repository at a pinned commit: the routes, the field names, the two different status
  vocabularies and the auth header all come from their source, and `docs/VERIFIED.md` §5
  records what was read. It has not been run against the live service.
- **The Remit signature is verified off chain only.** The on-chain authority is the Roles
  preset, so a Remit can narrow authority but cannot enforce itself. An on-chain registry
  is the right fix; shipping an unaudited contract in five days is not.
- **`workflowHash` binds a document KeeperHub has not seen.** It hashes our declaration of
  what must run; registering the workflow will reconcile the two, and the Remit is reissued
  if they differ.
- **Three intent kinds, Base only, no swaps.** `maxSlippageBps` is in the hashed limits and
  is never consulted.
- **NH-7 evidences the problem, not the fix.** Three concurrent intents on the direct path
  collide on nonce — which is exactly what KeeperHub's nonce management solves. Evidencing
  *its* behaviour needs the account.

### Why it is worth looking at anyway

One poisoned input, refused three separate times, with a receipt for each: G1 in
microseconds with zero network calls (counted, not claimed), G2 with a named `Status` from
the modifier's own enum and no gas, G4 reverting on chain. Seven enumerated non-happy-path
requirements, each demonstrated and each recorded. A receipt chain a stranger verifies from
a clean clone, which catches an edited receipt, a deleted one, and an edited one re-sealed
with a valid hash.

---

## BUIDL 2 — bounty, *Best KeeperHub Feature*

**What it is:** a **Check Role Policy** node for KeeperHub's existing `safe` plugin. It
asks the Zodiac Roles modifier whether a call would be allowed *before* the workflow
spends gas finding out.

**Why it is needed, in their words.** `lib/execute/simulate.ts`:

> Known limitation: `from` is resolved via `getOrganizationWalletAddress` … Orgs that route
> writes through a Safe will produce a simulation that reflects the EOA sending the call,
> not the Safe … does not perfectly mirror Safe-routed `msg.sender` semantics.

For a `safe-role` organization the Roles modifier is not in the simulated path at all: a
call the role forbids simulates clean, is broadcast, and reverts on chain. The refusal is
decoded correctly by their own `classifyRevert` — after the gas is gone. This node
simulates the outer `execTransactionWithRole` with `shouldRevert = true`, so the preflight
and the broadcast take the same path through the same contract.

**State:** written and verified inside a clone of their repository — `npx tsgo --noEmit`
exits 0 on the whole repo, `pnpm discover-plugins` registers it, and their 61 existing Safe
unit tests pass with the action registered.

**Not done:** unit tests and a fork test. The change is not mergeable without them and the
drafts say so.

**Not posted:** upstream requires an accepted issue before a pull request (`ISSUES.md`).
The issue and PR drafts are in `packages/keeperhub-safe/`. **[fill]** the links once filed.

**Note on the original plan:** the PRD targeted issue #1241 with four Safe nodes.
Verification found #1241 closed as completed on 2026-08-11 with Safe and Zodiac Roles
already shipped, so the contribution narrowed to the gap that is actually still there
rather than re-implementing working code. That reasoning is in
`docs/OPEN_QUESTIONS.md` OQ-3.

---

## Friday morning

The timetable in PLAN.md §8, with the parts a machine can do turned into one command.

```bash
pnpm --filter ops submit:check
```

Sixteen items: the quality gates actually run, a scan of the **whole git history** for key
material (not just the working tree — a key deleted in a later commit is still a key
anyone can `git log -p` out of the repository), every address in `addresses.ts` matched
against a row in `docs/VERIFIED.md`, every committed receipt chain re-verified, and the
three links the form will not accept as blank. It reads and computes; it never fixes
anything, because an item that fails is an item to go and fix.

Before that, the full path once more against a fork — 07:00 in the plan, and about four
minutes in practice:

```bash
anvil --fork-url https://sepolia.base.org --port 8546 &
export ANVIL_RPC_URL=http://127.0.0.1:8546

pnpm --filter @remit/core verify:constants        # the addresses still exist on chain
pnpm --filter ops p1            --network anvil   # Safe, Roles, preset, a transaction, a refusal
pnpm --filter ops remit:issue   --network anvil \
  --strategy strategies/remit_usdc_lender/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json
pnpm --filter ops remit:verify-digest --network anvil   # viem, foundry and the file agree
pnpm --filter ops g1            --network anvil   # 19 intents, every refusal code
pnpm --filter ops roles:diff    --network anvil   # the chain says what the preset says
pnpm --filter ops fund          --network anvil --usdc 100
pnpm --filter ops nh            --network anvil   # all seven, plus the injection story
uv run --directory packages/remit-bridge remit verify --network anvil
```

Then tag, then submit, and do not start anything new. Friday is for submitting a thing
that already works.

## Housekeeping before submitting

- [ ] No `.env`, no key, no credential anywhere in the git history
- [ ] `docs/VERIFIED.md` complete: every external address and endpoint, with source and date
- [ ] `docs/OPEN_QUESTIONS.md` honest and current
- [ ] `receipts/` committed, and `remit verify` passing from a clean clone
- [ ] Contact email plus an X or Discord handle, **both actually monitored** — finalists are
      invited by email
- [ ] Eligibility: 18+, not resident in an OFAC-restricted jurisdiction
