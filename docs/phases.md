# Remit — Build Phases

Companion to `PLAN.md`. The plan is a calendar; this is the dependency graph. Each phase
has one objective, an explicit entry condition, the requirement IDs it closes (`PRD.md` §5),
and an **exit gate** that is a fact about the world — a transaction hash, a decoded revert,
a passing verifier — never a feeling of progress.

Phases are ordered by dependency, not by team. Where two phases share no edge they can be
run in parallel by different owners (`PLAN.md` §1). Nothing in a phase may start before its
entry condition holds; if it does not hold, the correct action is to fix the prior phase,
not to work around it.

---

## Phase map

| # | Phase | Calendar (PLAN.md) | Owner | Blocks |
|---|---|---|---|---|
| P0 | Verification | Day 0, Sun 13 Sep | all | everything |
| P1 | Chain path | Day 1, Mon 14 Sep | Chain | P3, P4 |
| P2 | Core primitives | Day 1, Mon 14 Sep | Bridge | P3 |
| P3 | Execution path | Day 2, Tue 15 Sep | Bridge + Plugin | P5, P6 |
| P4 | Operations | Day 2, Tue 15 Sep | Chain | P6 |
| P5 | Strategy front | Day 3, Wed 16 Sep | Bridge | P6 |
| P6 | Mainnet proof | Day 3, Wed 16 Sep | Chain | submission viability |
| P7 | Bounty plugin | Day 1 → Day 3 | Plugin | bounty BUIDL |
| P8 | Failure surface | Day 4, Thu 17 Sep | all | the ranking |
| P9 | Presentation | Day 4, Thu 17 Sep | Console | main BUIDL |
| P10 | Submission | Day 5, Fri 18 Sep | all | — |

```
P0 ──┬── P1 ──┬── P3 ──┬── P5 ── P6 ──┬── P8 ── P9 ── P10
     │        │        │              │
     ├── P2 ──┘        └── P4 ────────┘
     │
     └── P7 ───────────────────────────────────────────┘
```

P7 runs alongside everything from Day 1. It is a separate BUIDL and must never become
blocked on the main track.

---

## P0 — Verification

**Objective** Replace every remembered API with a verified one.
**Entry** none.
**Tasks** `PLAN.md` 0.1–0.8.

Nothing in this phase produces product code. It produces rows in `docs/VERIFIED.md`: the
KeeperHub execute and executions paths with their real response shapes, the Almanak SDK
execution seam read from the installed source under `.venv/`, USDC and Aave v3 Pool on
Base, the Roles v2 deployment for 8453 and 84532, the Safe singleton and proxy factory,
and the pinned `gnosisguild/zodiac-modifier-roles` commit with `execTransactionWithRole`,
`ConditionFlat`, `ExecutionOptions` and the custom error ABI.

**Closes** the preconditions of `CLAUDE.md` §2.2.

**Status — 2026-09-13: closed, with two tasks blocked on credentials.**

| Task | State |
|---|---|
| 0.1 DoraHacks, Discord, office hours | **blocked** — needs a human with an account (OQ-2) |
| 0.2 KeeperHub account, key, MCP, one hand-run workflow | **blocked** — no account yet (OQ-1) |
| 0.3 KeeperHub API surface | verified from the repo at commit `f8c8f18c`; live confirmation pending OQ-1 |
| 0.4 Almanak SDK at a pinned version, execution seam | done — `almanak==2.28.0`, gRPC `ExecutionService`, **AL-2 GO** |
| 0.5 Addresses on Base and Base Sepolia | done — 24 assertions, both chains, re-runnable |
| 0.6 Roles v2 at a pinned tag | done — mastercopy **2.1.0**, full ABI and `Status` enum committed |
| 0.7 Issues #1241/#1784, CONTRIBUTING, plugin conventions | read and recorded. `pnpm create-plugin` deliberately not run — see OQ-3, the bounty premise needs a decision first |
| 0.8 Monorepo scaffold, CI | done — type-check, lint and ruff green locally; the workflow itself is unproven until a remote exists |

The go/no-go this phase existed for came out **GO on AL-2** and turned up three stale
premises in `PRD.md` instead (OQ-3 … OQ-5). The bounty track, not the Almanak adapter, is
the thing that now needs a decision.

**Exit gate**
- One trivial KeeperHub workflow executed by hand, returning a real `executionId`.
- `docs/VERIFIED.md` has a dated, sourced row for every address, ABI and path the build
  will touch.
- Green CI on an empty monorepo scaffolded per `CLAUDE.md` §3.
- A recorded go/no-go on AL-2. A closed or undocumented Almanak seam triggers cut line C6
  tonight, not on Wednesday.

---

## P1 — Chain path

**Objective** Move value out of a Safe through Zodiac Roles by hand, and make an
out-of-preset call fail with a name.
**Entry** P0 rows for Roles v2, Safe, USDC, Aave.
**Tasks** `PLAN.md` 1.1–1.5.

A 2-of-3 Safe on Base Sepolia, a Roles v2 instance enabled as a module, the agent signer
assigned to `roleKey`, and the minimal preset from `DOCS.md` §5: `approve` on USDC scoped
to the Aave pool, `supply`/`withdraw` with `onBehalfOf` and `to` pinned `EqualTo` the Safe,
`ExecutionOptions.None`.

**Closes** G4-1, G4-2, G4-3, and the on-chain half of G4-4.

**Status — 2026-09-14: complete on a fork of Base Sepolia; the public-testnet hash is blocked on funding (OQ-6).**

| Task | State |
|---|---|
| 1.1 2-of-3 Safe | done — deployed through the canonical v1.4.1 proxy factory |
| 1.2 Roles v2 instance, module enabled, agent assigned | done — proxy from ModuleProxyFactory 1.2.0 at the 2.1.0 mastercopy; membership confirmed by simulation, and a stranger confirmed to have none |
| 1.3 Minimal preset | done — 2 targets, 3 functions, `onBehalfOf`/`to` pinned with `EqualToAvatar`, `ExecutionOptions.None` |
| 1.4 `supply` by hand | done — approve, supply and withdraw all execute; the Safe's balance falls from 100 to 60 USDC |
| 1.5 Out-of-preset call, decoded | done — **three** distinct named refusals, not one: `ParameterNotAllowed`, `FunctionNotAllowed`, `TargetAddressNotAllowed`, plus an on-chain revert of the same call |

`pnpm --filter ops p1 --network anvil` reruns the whole phase end to end in about ten
seconds and asserts each outcome. Four consecutive clean runs, including one against a
fork started two seconds earlier.

The kill switch was also pulled and restored inside that run — `NoMembership()` on the
next preflight — which is P4 work arriving early because the ninety seconds it took was
worth more than the tidiness of leaving it for Tuesday.

**Exit gate**
- A Base Sepolia transaction hash from `execTransactionWithRole` via `cast`.
- A deliberate out-of-preset call (recipient = a random address) reverting with a **decoded
  named reason**, not a hex blob. An undecoded `0x…` fails this gate (`CLAUDE.md` §8).

If this gate is not met by Monday night, cut line C2 applies and Tuesday belongs to the
chain path.

---

## P2 — Core primitives

**Objective** `remit-core`: the Remit, the digest, the envelope.
**Entry** P0 scaffold.
**Tasks** `PLAN.md` 1.6–1.7. Runs in parallel with P1.

Remit type, canonical JSON with sorted keys and no whitespace, `limitsHash`, the EIP-712
domain and struct from `DOCS.md` §2.1, `remitDigest`. Then the `Intent` union, Zod schemas,
and `checkEnvelope` as a pure function with typed discriminated-union errors carrying
`code`, `field`, `expected`, `actual`.

**Closes** RM-1, RM-2, RM-3, G1-1, G1-2, G1-3, G1-4.

**Status — 2026-09-14: complete.**

| Task | State |
|---|---|
| 1.6 Remit type, canonical JSON, `limitsHash`, EIP-712, `remitDigest` | done — `remitHash` re-derived by viem, by foundry's `cast` from the EIP-712 definition, and from the committed file: three paths, one value |
| 1.7 `Intent` union, Zod schemas, `checkEnvelope` (G1), typed errors | done — 19 intents through the gate, every error code in the union reached, each refusal naming field, expected and actual |

Reproducibility is the requirement, so it is checked the only way that means anything:
canonical JSON hashes the same with the keys reversed, and a second library agrees with
the first. `strategyHash` on the issued Remit is keccak256 of a real file — the
`metamorpho_base_yield` strategy inside `almanak==2.28.0`. `workflowHash` is provisional
until P3 registers the workflow (OQ-7).

Two decisions worth carrying forward:

- **A spender is not a recipient.** `approve` names who may pull value and is checked
  against the venue list; `supply`/`withdraw` name where value lands and are checked
  against the recipient list. One list for both would let an approve to an attacker pass
  any allowlist that contains the Safe — which every allowlist does.
- **Withdrawals do not consume the daily cap.** Their recipient is pinned to the Safe, so
  they cannot be a way out, and charging them would tighten the cap as the agent unwinds.

`pnpm --filter ops propose` now runs G1 → G2 → chain over the issued Remit, with the spend
ledger on disk between runs. Three approve/supply cycles executed; the fourth was refused
at G1 by the hourly rate limit, in a separate process.

**Exit gate**
- `pnpm -r test` green, including hash-reproducibility tests: the same documents produce
  the same `remitHash` and `limitsHash` on a second machine.
- Four rejection tests, one per G1 failure class, each asserting the typed error rather
  than that an exception was thrown.
- A grep proves no code path accepts raw calldata, a raw target, or an ABI string from
  model output (`CLAUDE.md` §2.3).

---

## P3 — Execution path

**Objective** KeeperHub becomes the only thing that sends transactions, and every attempt
leaves a receipt.
**Entry** P1 exit gate and P2 exit gate.
**Tasks** `PLAN.md` 2.1–2.5, plus 1.8.

`safe.read_state`, `safe.policy_check` and `safe.exec_with_role` implemented against the
Roles Modifier deployed in P1. The workflow `read_state → policy_check → exec_with_role →
notify` registered with retries and private routing, its `workflowHash` pinned into the
Remit. The KeeperHub client with `execute` and `resolve_tx_hash`, correlating strictly on
`executionId` and raising `ReceiptUnresolvable` rather than writing an uncertain hash
(upstream #1784). The receipts module with `selfHash`, `prevHash` and `verify_chain`.

**Closes** G2-1, G2-2, G2-3, KH-1, KH-2, KH-3, KH-4, RC-1, RC-2, RC-3.

**Status — 2026-09-14: the receipt chain and the gates are done and observed; the
KeeperHub leg is written but unexercised, blocked on OQ-1.**

| Task | State |
|---|---|
| 2.3 KeeperHub client | written against the routes, field names, status vocabularies and auth header read from the repo at `f8c8f18c…`. Strict `executionId` correlation, capped backoff, `ReceiptUnresolvable` on ambiguity. **Never run against the live service** |
| 2.4 Receipts | done — `selfHash` over canonical JSON, `prevHash` chaining, `verify_chain` re-deriving every hash plus `remitHash`/`limitsHash` from the stored documents. Receipts written for refusals too |
| 2.5 G1 → compile → execute → receipt | done end to end, minus KeeperHub: six receipts over a fork, written by both the TypeScript ops path and the Python bridge, all verifying in one chain |
| 2.1 / 1.8 plugin nodes | **deferred to P7.** `safe.policy_check` and `safe.exec_with_role` are plugin-shaped work whose premise P0 found to be stale (OQ-3), and upstream requires an accepted issue before a pull request (OQ-4). The capability itself exists — preflight and execution are in `ops` and `@remit/core` — so nothing downstream waits on it |

The one architectural decision this phase forced: **the bridge does not reimplement the
core.** The gate, canonical JSON, the EIP-712 digest and the receipt hash are TypeScript,
and Python calls them over a process boundary. A subprocess per decision is cheap next to
a receipt chain that silently forks because two languages disagreed about key order.

Three tamper modes were tried against a committed chain and all three were caught,
including a re-sealed receipt with a valid hash — the chain link catches what the hash
alone cannot.

**Exit gate**
- A transaction that went Intent → G1 → KeeperHub → Roles → Safe, with a receipt written
  for it and a receipt written for a rejection.
- G2 returns a decoded reason for the P1 out-of-preset case, with zero gas consumed.
- No `eth_sendRawTransaction` anywhere in the repository.

This is the core of the product. Everything after it is integration and presentation.

---

## P4 — Operations

**Objective** The permission set is reviewable and revocable by someone who did not write it.
**Entry** P1 exit gate.
**Tasks** `PLAN.md` 2.6–2.7. Parallel with P3.

`roles:build`, `roles:diff`, `roles:apply` and `kill` under `ops/scripts`. `roles:diff`
prints the exact permission delta before anything is applied — mandatory before apply, per
`PRD.md` §9.

**Closes** the operational half of NH-4, and the `CLAUDE.md` §2.4 mainnet path.

**Status — 2026-09-14: complete.**

| Task | State |
|---|---|
| 2.6 `roles:build`, `roles:diff`, `roles:apply`, `kill` | done. `roles:diff` reconstructs the role by replaying the Roles Modifier's own events — there is no getter for a role's scope, and `ScopeFunction` carries the whole condition tree in the log |
| 2.7 Kill switch verified | done — pulled, preflight observed to fail with `NoMembership()`, restored, with a receipt for every state |

`roles:diff` proved itself both ways: zero differences immediately after an apply, and an
exact `+ withdraw(…) [WIDENS AUTHORITY]` after the function was revoked on chain by hand.
With `withdraw` revoked, a withdraw intent passed G1 and was refused at G2 with
`FunctionNotAllowed` — the preset-tightened-after-the-Remit case (NH-2), reached without
editing a thing.

`roles:apply` now runs the diff first, refuses when there is nothing to do, and on mainnet
refuses a widening without `--yes`. Read-only scripts (`roles:diff`, `roles:build`,
`status`, `g1`) are exempt from `--confirm`: making an operator type it to *look* at
something teaches them to type it without reading, which is the habit the flag exists to
prevent.

`exec:mainnet` is the awkward path CLAUDE.md §2.4 asks for. Four separate acts of intent
before anything is sent: the network named, `--confirm`, the Remit named **by hash** and
matched against the issued document, and the decoded action — Safe, roleKey, value,
recipient, caps, headroom — printed first. It runs the same pipeline as `propose`, because
a mainnet path with its own copy of the gates is a mainnet path nobody has rehearsed.

**Exit gate**
- `roles:diff` output is read and understood by a team member who did not write the preset.
- The kill switch is pulled, G2 is observed to fail, membership is restored — with a
  committed receipt for both states.

---

## P5 — Strategy front

**Objective** An unmodified Almanak strategy drives the path.
**Entry** P3 exit gate, P0 AL-2 go decision.
**Tasks** `PLAN.md` 3.1–3.4.

The adapter implements the seam identified in P0 and contains **zero strategy logic** — it
maps one strategy action to one typed Intent and nothing else. A minimal pinned strategy
(a USDC supply/withdraw rule is sufficient) yields `strategyHash` from its source. The
startup assertion compares Remit limits against the on-chain preset and refuses to run on
drift.

**Closes** AL-1, AL-2, AL-3, AL-4, RM-4.

**Status — 2026-09-14: complete, except the public-testnet transaction hash, which is the
same blocker as P1's (OQ-6) and P3's (OQ-1).**

| Task | State |
|---|---|
| 3.1 The adapter | done — `ExecutionServiceServicer` from Almanak's own generated stubs. A strategy reaches it through `ALMANAK_GATEWAY_HOST`/`PORT`; no fork of the SDK, no patched strategy |
| 3.2 A pinned strategy | done — `strategies/remit_usdc_lender/strategy.py`, an unmodified `IntentStrategy` with no Remit imports, hashed into the Remit |
| 3.3 End to end | done on a fork: the strategy read the Safe's real balance, decided `SUPPLY 5 USDC`, and its serialised intent crossed Almanak's own `GatewayClient` into Remit, through G1 and G2. `Execute` without `dry_run` needs KeeperHub, which needs an account (OQ-1) |
| 3.4 Startup drift assertion | done — and doubled: the bridge refuses to start on preset drift (RM-4) *and* on strategy drift |

**AL-3 is enforced by what the adapter is missing.** It maps one Almanak intent onto one
typed Remit intent and refuses what it does not recognise — an unknown protocol, an
unknown token, a chained `amount: "all"`. It decides nothing about markets, sizing or
timing, because a bridge that second-guesses a strategy is a second strategy nobody
reviewed.

The rogue intents matter as much as the happy path: four crafted intents went through the
same client and the same seam, and came back `PROTOCOL_UNSUPPORTED`,
`REMIT_CAP_EXCEEDED_PER_TX`, `AMOUNT_CHAINED` and `ASSET_UNSUPPORTED`. None of them
bypassed anything; that is the point of sending them through the front door, and it is the
material P8 needs.

**Exit gate**
- A Base Sepolia transaction hash produced by the strategy through the adapter.
- Tightening the preset by hand causes the bridge to refuse to start, with
  `REMIT_PRESET_DRIFT`.

Under cut line C6 this phase is replaced, not deleted: Safe + Zodiac Roles becomes the
named live project, the architecture is unchanged, and only the pitch is rewritten.

---

## P6 — Mainnet proof

**Objective** Secure the submission requirement.
**Entry** P3 exit gate. P5 is *not* a prerequisite — do not let the adapter hold this up.
**Tasks** `PLAN.md` 3.5–3.6.

A separate mainnet Safe, a separate Roles instance, a preset with 5 USDC per-transaction
and 25 USDC daily caps, a separate Remit, ~30 USDC funded. Execution through
`ops exec --network base --confirm`, which prints the decoded action, Safe, roleKey, value
and recipient before proceeding.

**Closes** G-1, RC-4, and acceptance criterion 1 (`PRD.md` §6).

**Status — 2026-09-14: everything but the button. The transaction itself needs a funded
key and a KeeperHub account (OQ-6, OQ-1); it is not routed around.**

| Task | State |
|---|---|
| 3.5 Mainnet setup | **rehearsed, not done.** The full sequence — separate Safe, separate Roles instance, preset with mainnet addresses, 5/25 caps, separate Remit, 30 USDC — ran end to end on a fork of Base mainnet at chain 8453 |
| 3.6 The proof transaction | **rehearsed, not done.** `exec:mainnet` executed `approve` and `supply` through `execTransactionWithRole` on the fork, with the full ceremony, leaving receipts |

What P6 added beyond the rehearsal:

- **`mainnet:preflight`** — sixteen checks that must hold before anything is spent,
  including two that are easy to get wrong and expensive to discover late: the agent must
  not be a Safe owner, and the preset must have **zero** drift from the Remit. Reads only,
  so it runs before every attempt rather than once.
- **`docs/MAINNET.md`** — the runbook, with measured gas. The whole sequence is 1,873,335
  gas, about 0.0000112 ETH. Gas is not the constraint; the 30 USDC is.
- **An `anvil-base` network** — a fork of Base mainnet, so the mainnet path is rehearsed
  against the addresses it will actually use rather than against a testnet analogue. That
  caught a real difference: Circle's USDC cannot be minted the way the Aave test token can.

The exit gate is the one thing in this build that cannot be substituted for, so it is
stated plainly rather than approximated: **there is no Base mainnet transaction yet**, and
nothing in the repository implies there is.

**Exit gate**
- A Base mainnet transaction hash, executed through KeeperHub via `execTransactionWithRole`,
  with the Basescan link and the receipt **committed to the repository**.

From this moment the submission is viable even if every later phase fails. That is the
whole reason this phase sits on Wednesday.

---

## P7 — Bounty plugin

**Objective** A pull request KeeperHub can merge.
**Entry** P0 task 0.7 (scaffold and conventions understood).
**Tasks** `PLAN.md` 1.8, 1.9, 2.1, 3.8. Runs across Days 1–3, in public.

Opened as a **draft on Monday with two nodes** and refined all week. A PR dropped at 11:50
on Friday reads very differently to a judge. `safe.propose` via the Safe Transaction Service
completes the surface; unit tests plus one Base Sepolia fork test and a docs page complete
the requirements; the PR description references and closes #1241 and pastes the output of a
real run.

**Closes** BP-2, BP-3, BP-5. **BP-1 is answered differently** and **BP-4 is not done** —
see below.

**Status — 2026-09-14: the code is written and verified inside a clone of their
repository. It is not posted, and it has no tests.**

P0 found the premise stale (OQ-3): #1241 closed as completed, `plugins/safe/` and the whole
Zodiac Roles path already shipped, and `decode-revert-error.ts` already decoding the
modifier's `Status` enum. Building BP-1's four nodes would have meant re-implementing
working code and opening a pull request against a closed issue.

So the contribution narrowed to the gap upstream documents in its own source —
`lib/execute/simulate.ts` says its simulation "does not perfectly mirror Safe-routed
`msg.sender` semantics", and for a `safe-role` org the Roles modifier is not in the
simulated path at all. One action, **Check Role Policy**, asks the question before the gas
is spent instead of decoding the answer afterwards.

| Requirement | State |
|---|---|
| BP-1 four nodes | **answered differently.** Three of the four exist upstream already; the fourth, `policy_check`, is what this contributes |
| BP-2 matches their conventions | done — `"use step"`, `runPluginStep`, `maxRetries = 0`, the core-file pattern, their action-definition shape |
| BP-3 self-contained, copies cleanly | **verified by doing it**: copied into a clone, `npx tsgo --noEmit` exits 0, `pnpm discover-plugins` registers it, their 61 Safe unit tests pass |
| BP-4 unit tests + fork test | **not done.** Tests were out of scope for this build by instruction. This is the remaining work before the PR can be opened, and it is named as such in the drafts |
| BP-5 docs page + PR referencing the issue | docs page written; the issue and PR drafts are written and **unposted** — upstream requires an accepted issue first (OQ-4), and posting is the repository owner's action |

Their tooling caught three things reading alone would not: `StepContext` has no `userId`,
`getChainIdFromNetwork` is synchronous, and the repository targets ES2017 so `0n` does not
compile. Verification by running beats verification by reading, every time.

**Exit gate**
- `packages/keeperhub-safe/` copies into `keeperhub/plugins/safe/` with **no edits** and no
  import from `remit-core` — verified by actually doing it in a fork.
- Tests pass in that fork. PR out of draft.

Under cut line C2, `safe.propose` is dropped and the three Roles-path nodes stand alone.
The PR still ships.

---

## P8 — Failure surface

**Objective** Make the refusals legible. This is the phase that wins the ranking, because
every other team will have a happy path and almost none will have this.
**Entry** P6 exit gate.
**Tasks** `PLAN.md` 4.1–4.3, 4.5.

NH-1…NH-7, each with a test and each with a committed receipt. The centrepiece is the
injection scenario: a crafted strategy input redirecting funds to an attacker address,
rejected at G1 with no network call, then — with G1 disabled — at G2 with a decoded reason
and no gas, then — with G2 disabled — on chain at G4. Three receipts, three independent
refusals, one story. Plus the concurrency evidence: three intents fired at once, all landing
in order.

**Closes** NH-1…NH-7, RC-3 verified by a third party, acceptance criteria 2 and 3.

**Status — 2026-09-14: complete, with NH-7 answered honestly rather than favourably.**

`pnpm --filter ops nh --network anvil` runs all seven requirements and the injection
scenario in one pass, writing a receipt for each into the same chain as every real run.
Eight of eight hold.

Two results worth reading twice:

- **NH-1 is evidenced, not asserted.** "No network call was made" is a claim about what
  did not happen, so the runner counts RPC requests around the gate and reports the
  number. It is zero.
- **NH-7 is a finding.** Three intents fired at once on the ops-direct path: one landed,
  two were refused on nonce. Three transactions from one EOA with no nonce manager collide,
  and the client refuses rather than silently replacing one. Serialised, all three land in
  order. That is the problem KeeperHub solves, and evidencing *its* solution needs an
  account (OQ-1) — so the receipt says `ops-direct` and the phase says so too.

**No bypass flag was added** (CLAUDE.md §2.5). The gates are independent functions and the
runner asks each directly; nothing in it is reachable from `propose`, `exec:mainnet` or
`remit serve`.

The injection scenario ran twice in a row unattended — G1 refuses with no network call, G2
refuses with a named `Status` and no gas, the chain reverts, and the attacker's balance is
still zero.

`verifyReceiptChain` ran from a fresh `git clone` with `pnpm install` and nothing else:
18 receipts checked against the Remit and limits documents, chain intact, and a one-field
edit caught by the clone's own verifier. The *human* half of 4.5 — someone who did not
write it running it — is still owed, and is thirty seconds of somebody else's time.

**Exit gate**
- Seven receipts in `receipts/`.
- The injection scenario runs **twice in a row** without intervention.
- `verifyReceiptChain` passes from a clean clone, run by whoever did not write it.

---

## P9 — Presentation

**Objective** A stranger can run it; a judge can watch it.
**Entry** P8 exit gate.
**Tasks** `PLAN.md` 4.4, 4.6, 4.7, 4.8.

Console: ledger with chain-integrity indicator and links out, review queue with the decoded
action and the G2 result, kill switch screen with live membership, Remit screen with
headroom and expiry, gate counters. `README.md` with the pitch, the architecture diagram,
four-command setup, both transaction links and the PR link. The three-minute video recorded
per `PLAN.md` §10 — **on Thursday, not Friday**. The DoraHacks draft, with the "what still
breaks" answer taken verbatim in spirit from `PRD.md` §8; candour has never hurt a submission.

**Closes** CN-1…CN-5, RC-5, G3-1…G3-3, acceptance criteria 6 and 7.

**Status — 2026-09-14: the console and the documents are done. The video is not, and
cannot be from here (OQ-10).**

| Task | State |
|---|---|
| 4.4 Console | done — five screens on live data: gate counters, the ledger with integrity re-checked on every load, the Remit with headroom and expiry, the review queue, and the kill switch reading membership from the chain |
| 4.6 README | done — pitch, the four gates, the preset that is the product, four-command setup, what is where, how to verify it yourself, and the transaction links **stated as missing** rather than implied |
| 4.7 Demo video | **not done.** `docs/DEMO.md` is the script, timed, with every command working today and the questions to have answers ready for. Recording it is somebody's Thursday |
| 4.8 Submission draft | done — `docs/SUBMISSION.md`, both BUIDLs, with the three blocked fields marked `[fill]` |

G3 stopped being a placeholder. An action above the review threshold now enqueues and the
pipeline *waits*; the console shows the decoded action in named parameters and writes a
decision; declining produces a terminal `declined_g3` receipt in the same chain as every
other outcome. A timeout is treated as a refusal, because a review that times out into an
approval is not a review.

The console reads the repository's own files and holds no keys. It cannot pull the kill
switch — it prints the calldata and the address instead, so the switch works when our stack
is the thing that has failed.

**Exit gate**
- Video uploaded.
- Someone outside the team follows `README.md` from a clean clone and reaches a running
  console.
- **No new features after 18:00.** Tests, documentation, recording and rehearsal only.

Under cut lines C3 and C7 the console degrades to a CLI approval prompt and a single static
ledger page generated from `receipts/`. The G3 gate itself is never cut — only its UI.

---

## P10 — Submission

**Objective** Submit a thing that already works.
**Entry** P9 exit gate.
**Tasks** `PLAN.md` §8 timetable, `PLAN.md` §11 checklist.

Morning re-run on Base Sepolia, mainnet link re-resolved, `verifyReceiptChain` re-run, repo
tagged, `receipts/` committed, `.env` absent from history. Then BUIDL #1 on the main track
by 10:30 and BUIDL #2 for the bounty by 11:15 — separate submissions, as the rules require —
with 45 minutes of buffer before the 12:00 CEST hard close.

**Exit gate**
- Both BUIDLs submitted with all mandatory fields; an incomplete submission cannot be judged.
- Contact email plus an X or Discord handle, both actually monitored — finalists are
  invited by email.

**Nothing new starts on Friday.**

---

## Invariants across every phase

These hold at every exit gate. A phase that meets its own gate while breaking one of these
is not done (`CLAUDE.md` §7).

1. `pnpm -r type-check && pnpm -r lint && pnpm -r test` and `pytest` all pass.
2. At least one test per change exercises the **failure** path.
3. Every new address, ABI or endpoint is in `docs/VERIFIED.md` with a source and a date.
4. No secret, key or credential in the diff or anywhere in git history.
5. The change has been run against a real network — Anvil fork of Base, Base Sepolia, or
   Base mainnet — and the output is pasted into the task notes.
6. The four gates remain independent. No collapsing, no bypass flag. If a change leaves G4
   as the only thing between a hallucination and the treasury, the change is wrong.
7. No mocks, no stubs, no invented data. A blocked task goes into
   `docs/OPEN_QUESTIONS.md`; it does not get simulated.

---

## Cut order

From `PLAN.md` §9, applied in this order without debate when time runs short. The phase
column says where the loss lands.

| # | Cut | Phase | Keep instead |
|---|---|---|---|
| C1 | On-chain receipt anchoring (RC-6) | P3 | Off-chain hash chain only |
| C2 | `safe.propose` node | P7 | The three Roles-path nodes |
| C3 | Console review screen | P9 | G3 as a CLI prompt — the gate survives |
| C4 | Fork-simulated balance delta | P9 | Decoded action only |
| C5 | Remit owner signatures (RM-5) | P2 | Unsigned Remit; the preset is the real authority |
| C6 | Almanak adapter | P5 | Safe + Zodiac Roles as the named live project |
| C7 | Console entirely | P9 | A static ledger page generated from `receipts/` |

**Never cut, at any phase:** the four gates, the mainnet transaction, the receipt chain,
the bounty PR. Those four are the submission.
