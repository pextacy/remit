# Remit — Product Requirements Document

**Version** 1.0
**Status** Approved for build
**Event** KeeperHub hackathon on DoraHacks
**Category** Main track — *Best Integration into a Live Project* ($4,000, ranked)
**Stacked with** Bounty — *Best KeeperHub Feature* ($1,000, two winners), submitted as a
separate BUIDL per the event rules

---

## 1. Summary

Remit is a bounded-authority execution layer that lets an AI strategy on **Almanak**
move real value through **KeeperHub** out of a **Safe**, while a **Zodiac Roles Modifier v2**
preset makes it structurally impossible for the agent to exceed the authority it was
granted — and produces a verifiable receipt chain linking every transaction back to the
exact strategy version that caused it.

One sentence: *the agent proposes, the human bounds, KeeperHub executes deterministically,
and the chain enforces the boundary.*

---

## 2. Problem statement

Almanak is live and lets users deploy AI-built DeFi strategies into their own Safe with
scoped permissions. KeeperHub is production execution infrastructure with nonce management,
gas escalation, private routing, retries and an audit trail. Both are strong. Between them
sits an unsolved gap:

- Almanak scopes permissions per strategy, but the **execution leg** of any agent platform
  is where transactions get stuck, front-run, mis-nonced, or silently dropped.
- KeeperHub removes execution-time inference, but has **no first-class Safe support**
  (open issue #1241, milestone 2026 Q2) and therefore cannot serve Safe-custodied
  treasuries — which is where institutional agent capital actually sits.
- Neither produces **provenance**: after a transaction lands, nobody can prove which
  strategy version produced it, what authority it acted under, or that the authority was
  never exceeded.

A treasury operator today must choose between an agent that is genuinely autonomous and an
agent they can defend in a post-mortem. Remit removes the choice.

---

## 3. Users

| User | Situation today | What Remit changes |
|---|---|---|
| **DAO / fund treasury operator** | Wants automated yield management. Will not hand an LLM a hot key. Approves every transaction manually, so automation dies. | Signs one Remit. Agent operates autonomously inside it. Kill switch is one owner transaction. |
| **Almanak strategy author** | Strategy logic is good; execution is the flaky part and is their problem to own. | Points the strategy at Remit. Gets KeeperHub's execution reliability without writing any of it. |
| **Auditor / risk reviewer** | Reconstructs agent behaviour from logs the agent wrote. | Verifies the committed receipt chain independently, with no access to our systems. |
| **KeeperHub team (bounty)** | #1241 open since May, blocking Safe-custodied users. | Receives a mergeable Safe plugin with both the multisig-proposal path and the Roles path. |

Primary user for the build and demo: **the treasury operator.**

---

## 4. Goals and non-goals

### Goals

- G-1 Prove real value movement through KeeperHub, out of a Safe, on Base mainnet.
- G-2 Make agent scope-widening impossible at the EVM level, and demonstrate it live.
- G-3 Produce a provenance chain that a third party can verify without trusting us.
- G-4 Ship a Safe plugin KeeperHub can merge.
- G-5 Be runnable live, end to end, on a call, in under four minutes.

### Non-goals

- NG-1 Profitability. Remit is infrastructure; yield is not a judging criterion.
- NG-2 Any custom Solidity contract.
- NG-3 Chains other than Base and Base Sepolia.
- NG-4 Multi-tenant hosting, billing, accounts, or a token.
- NG-5 Reimplementing anything Almanak or KeeperHub already does.

---

## 5. Requirements

Priority: **P0** must ship or the submission fails. **P1** materially improves the score.
**P2** only if P0 and P1 are complete and stable.

### 5.1 Remit document

| ID | Priority | Requirement |
|---|---|---|
| RM-1 | P0 | A Remit binds strategyHash, workflowHash, safe, rolesModifier, roleKey, limitsHash, chainId, notBefore, notAfter, nonce. |
| RM-2 | P0 | `remitHash` is the EIP-712 digest, deterministic and reproducible from the committed documents by any third party. |
| RM-3 | P0 | Limits are canonicalised (sorted keys, no whitespace) before hashing; `limitsHash` is reproducible. |
| RM-4 | P0 | The bridge refuses to start if the Remit limits and the on-chain Roles preset disagree. |
| RM-5 | P1 | Remit is signed by Safe owners via `eth_signTypedData_v4`; signatures verified off-chain at startup. |
| RM-6 | P1 | Remit expiry (`notAfter`) is enforced and surfaced in the console. |

### 5.2 Gate G1 — envelope

| ID | Priority | Requirement |
|---|---|---|
| G1-1 | P0 | Pure function, no network access, rejects before any I/O. |
| G1-2 | P0 | Enforces: allowed intent kinds, allowed targets, allowed selectors, allowed recipients, per-tx cap, rolling 24h cap, time window, rate limit. |
| G1-3 | P0 | Returns a typed error with `code`, failing `field`, `expected` and `actual`. Never a bare string. |
| G1-4 | P0 | No code path accepts raw calldata, a raw target address, or an ABI string originating from model output. |
| G1-5 | P1 | Rolling spend ledger is persisted and survives a bridge restart. |

### 5.3 Gate G2 — preflight

| ID | Priority | Requirement |
|---|---|---|
| G2-1 | P0 | `eth_call` simulation of `execTransactionWithRole` with `shouldRevert = true`, from the agent signer, against the Roles Modifier. |
| G2-2 | P0 | On revert, the Roles v2 error is decoded to a named reason. An undecoded hex blob is a failed requirement. |
| G2-3 | P0 | Zero gas consumed regardless of outcome. |
| G2-4 | P1 | Result is surfaced in the console review screen alongside the decoded action. |

### 5.4 Gate G3 — review

| ID | Priority | Requirement |
|---|---|---|
| G3-1 | P0 | Actions above `requireReviewAboveUsd` pause for operator approval. |
| G3-2 | P0 | The review screen shows the decoded action with named parameters, not raw calldata. |
| G3-3 | P0 | Decline is recorded as a terminal receipt with `outcome: "declined_g3"`. |
| G3-4 | P1 | Fork-simulated Safe balance delta is shown next to the action. |
| G3-5 | P1 | A changed `strategyHash` forces review regardless of notional. |

### 5.5 Gate G4 — on-chain

| ID | Priority | Requirement |
|---|---|---|
| G4-1 | P0 | Execution goes through `execTransactionWithRole` on the Roles Modifier, never directly from an EOA to the target. |
| G4-2 | P0 | The preset pins recipient parameters (`onBehalfOf`, `to`) to the Safe address. |
| G4-3 | P0 | `ExecutionOptions.None` — no native value transfer, no delegatecall for the agent role. |
| G4-4 | P0 | A transaction violating the preset reverts on chain, and the revert is captured in a receipt. |

### 5.6 Almanak integration

| ID | Priority | Requirement |
|---|---|---|
| AL-1 | P0 | The strategy runs as an unmodified Almanak strategy at a pinned SDK version. |
| AL-2 | P0 | Remit implements Almanak's own execution/gateway seam. No fork of the Almanak SDK. |
| AL-3 | P0 | The adapter contains zero strategy logic; it only maps one strategy action to one typed Intent. |
| AL-4 | P0 | `strategyHash` is the keccak256 of the pinned strategy source and is recorded in every receipt. |
| AL-5 | P1 | Almanak's alerting/stuck-detection continues to function alongside Remit; the two do not fight over execution state. |

### 5.7 KeeperHub integration

| ID | Priority | Requirement |
|---|---|---|
| KH-1 | P0 | Every transaction is submitted by KeeperHub. No direct `eth_sendRawTransaction` from Remit code, ever. |
| KH-2 | P0 | Workflows are registered in advance; the bridge invokes them by id with typed inputs. |
| KH-3 | P0 | `workflowHash` is the keccak256 of the canonicalised workflow definition and is pinned in the Remit. |
| KH-4 | P0 | `txHash` is resolved by polling the executions endpoint and correlating strictly on `executionId`. Ambiguity raises an error rather than writing an uncertain hash. |
| KH-5 | P1 | Private routing and retry/backoff are enabled on the workflow and evidenced in the run log. |
| KH-6 | P1 | KeeperHub notification nodes (Discord or Telegram) post each executed receipt to the operator channel. |

### 5.8 Provenance receipts

| ID | Priority | Requirement |
|---|---|---|
| RC-1 | P0 | One receipt per attempt, including rejections and declines. |
| RC-2 | P0 | Hash-chained: `selfHash` over canonical JSON, `prevHash` linking to the previous record. |
| RC-3 | P0 | `verifyReceiptChain` re-derives every hash and re-derives `remitHash` and `limitsHash` from the stored documents. |
| RC-4 | P0 | Receipts from the real mainnet and testnet runs are committed to `receipts/` in the repository. |
| RC-5 | P1 | Console displays chain integrity status and links each receipt to KeeperHub and Basescan. |
| RC-6 | P2 | Receipt root anchored on chain in a transaction's calldata. |

### 5.9 Console

| ID | Priority | Requirement |
|---|---|---|
| CN-1 | P0 | Review queue with approve/decline. |
| CN-2 | P0 | Receipt ledger with links out. |
| CN-3 | P0 | Kill switch screen: live Roles membership status and the revocation transaction to sign. |
| CN-4 | P1 | Remit screen: hashes, limits, remaining headroom, expiry. |
| CN-5 | P1 | Gate outcome counters — attempts and rejections at each gate. |

### 5.10 Bounty — KeeperHub Safe plugin

| ID | Priority | Requirement |
|---|---|---|
| BP-1 | P0 | Four nodes: `safe.read_state`, `safe.policy_check`, `safe.exec_with_role`, `safe.propose`. |
| BP-2 | P0 | Generated with the repository's own `pnpm create-plugin` scaffold and matching `keeperhub/plugins/` conventions. |
| BP-3 | P0 | Self-contained: no imports from the Remit repository. Copy-pasteable into a fork with no edits. |
| BP-4 | P0 | Unit tests plus one fork test against Base Sepolia. |
| BP-5 | P0 | Docs page added under `docs/`, and the PR description explicitly references and closes issue #1241. |
| BP-6 | P1 | Prometheus metrics wired to the existing metrics collector. |
| BP-7 | P2 | Second PR fixing issue #1784 (`txHash` absent from the execute response). |

### 5.11 Non-happy-path behaviour

| ID | Priority | Requirement |
|---|---|---|
| NH-1 | P0 | Out-of-envelope target → rejected at G1, receipt written, no network call made. |
| NH-2 | P0 | Preset tightened after the Remit was signed → rejected at G2 with a decoded reason, no gas spent. |
| NH-3 | P0 | Forced out-of-preset transaction → reverts at G4, revert captured in a receipt. |
| NH-4 | P0 | Kill switch pulled mid-session → G2 and G4 both fail, and the receipts show the transition. |
| NH-5 | P1 | Daily cap exhausted → rejected at G1, console shows zero headroom. |
| NH-6 | P1 | RPC unavailable → backoff and retry, then a `rejected_g2` receipt. Never executes blind. |
| NH-7 | P1 | Three concurrent intents → all land in order, evidencing KeeperHub nonce management. |

---

## 6. Acceptance criteria

The submission is complete when all of the following hold.

1. **Mainnet proof.** At least one transaction executed on Base mainnet through
   KeeperHub, through `execTransactionWithRole`, out of the demo Safe. Basescan link
   included in the submission.
2. **Refusal proof.** A live, reproducible demonstration that a scope-widening instruction
   is rejected independently at G1, at G2, and at G4, with the receipt for each.
3. **Verifiable provenance.** `verifyReceiptChain` passes on the committed `receipts/`
   directory, run from a clean clone by someone with no access to our infrastructure.
4. **Real integration.** The strategy runs as an unmodified Almanak strategy at a pinned
   SDK version, with the Almanak version and commit recorded in every receipt.
5. **Mergeable bounty.** The Safe plugin PR is open against `KeeperHub/keeperhub`, tests
   pass, and the description references issue #1241.
6. **Submission artefacts.** Source link, demo video showing the integration working, and
   a link to a transaction executed through KeeperHub. All three present.
7. **Runs live.** The full path executes end to end in under four minutes in front of an
   audience, on Base Sepolia, without a rehearsed recording.

---

## 7. Mapping to the judging rubric

| Rubric criterion | How Remit answers it |
|---|---|
| **Integration depth** — real, named project on the other side, specific to it | Almanak, pinned SDK version, implementing their own execution seam. Plus Safe and Zodiac Roles v2 — both live, audited, and used in production by ENS DAO, GnosisDAO, Balancer and Gnosis Pay. Not a generic wrapper: the adapter is written against the installed SDK source. |
| **Execution through KeeperHub** — did value move, can we see it | Every transaction is submitted by KeeperHub; Remit has no raw-send path at all. Mainnet and testnet transaction links, cross-referenced from receipts by `executionId`. |
| **Reliability and observability** — survives outside the happy path | Seven enumerated non-happy-path requirements (NH-1…NH-7), each with a test and each demonstrated. Refusals are recorded, not swallowed. G2 gives the operator the reason *before* gas is spent. |
| **Usefulness and originality** — solves something real for users of the integrated project | Almanak users get SLA-grade execution and an auditable trail without writing execution code. Provenance receipts — strategy version → workflow → role → txHash — do not exist anywhere today. |
| **Developer experience and code quality** — could another team pick this up | Typed schemas at every boundary, typed errors, zero custom Solidity, four-command setup, `roles:diff` before `roles:apply`, and a self-contained plugin that copies cleanly into KeeperHub's own tree. |

| Bounty criterion | How the plugin answers it |
|---|---|
| Mergeability | Targets an open, milestoned issue; uses their scaffold and conventions; self-contained; no repository-specific dependencies. |
| Value to the platform | Unblocks every Safe-custodied treasury. Covers both the multisig-proposal path and the bounded-autonomy Roles path. |
| Code quality and tests | Unit tests plus a Base Sepolia fork test; typed errors; metrics wired to the existing collector. |
| Scope and completeness | Four nodes covering read, preflight, execute and propose — a coherent surface, not a single function. |

---

## 8. Submission form answers

**Which project did you integrate with, and what does the integration do?**
Almanak, the live AI quant platform. Remit makes KeeperHub the execution layer for
Almanak strategies operating out of a Safe. The strategy decides; a signed Remit bounds
what it may do; KeeperHub executes deterministically; a Zodiac Roles v2 preset enforces the
boundary on chain. Every run produces a hash-chained receipt linking the strategy version
to the transaction hash.

**Which KeeperHub surfaces did you use?**
MCP server for agent-authored workflow composition during development; the workflow
execution API for every transaction; agent-authored workflows reviewed and pinned by hash
before use; the audit trail and execution history for receipt correlation; notification
nodes for operator alerts. Plus a new Safe plugin contributed upstream.

**Testnet or mainnet?**
Both. Development and the live demo run on Base Sepolia. Mainnet proof transactions on
Base, with a 5 USDC per-transaction and 25 USDC daily cap enforced in both the Remit and
the Roles preset.

**What still breaks or is unfinished?**
The Remit signature is verified off chain only; the on-chain authority is the Roles
preset, so a Remit can narrow authority but cannot enforce itself. An on-chain Remit
registry is the right fix and was deliberately left out rather than shipping an unaudited
contract in five days. `txHash` resolution depends on polling because the execute response
does not return it (upstream #1784); ambiguous correlation raises an error instead of
writing an uncertain hash. Only three intent kinds are implemented. Base only.

---

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Almanak SDK seam is closed or undocumented | High — the integration story weakens | Day-1 spike, timeboxed. Fallback: the same architecture with Safe + Zodiac Roles as the named live project, which is unambiguously live and in production at ENS DAO, GnosisDAO and Balancer. |
| Roles v2 preset built incorrectly | High — wrong authority granted | `roles:diff` mandatory before apply; recipient parameters pinned to the Safe; testnet first |
| Five-day timeline | High | P0/P1/P2 tiering; cut lines defined in PLAN.md; mainnet proof transaction prioritised on day 4, not day 5 |
| KeeperHub API behaviour differs from docs | Medium | Day-1 verification spike against the live API; everything recorded in `docs/VERIFIED.md` |
| Bounty PR not mergeable in time | Medium | Plugin built self-contained from day 2, PR opened early and iterated in public |
| Base mainnet congestion during the demo | Low | Demo runs on Base Sepolia; mainnet proof is pre-recorded in the receipts and linked |
