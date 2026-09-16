# CLAUDE.md

Working agreement for any coding agent (Claude Code, Cursor, Codex) operating in this
repository. Read this file fully before the first edit of a session. If an instruction
here conflicts with a user request, surface the conflict instead of silently resolving it.

---

## 1. What this project is

**Remit** is a bounded-authority execution layer for onchain AI agents.

A strategy running on **Almanak** (live quant/DeFi agent platform, almanak.co) decides
*what should happen*. **KeeperHub** executes it deterministically. A **Safe** holds the
funds and a **Zodiac Roles Modifier v2** module enforces, at the EVM level, the maximum
set of actions the agent is permitted to take. The agent can propose. It can never widen
its own authority.

The product primitive is a **Remit**: a signed, versioned document that binds four
things together so that they must agree or nothing executes.

| Binding | Answers | Enforced by |
|---|---|---|
| Almanak strategy version hash | *Why* the action happened | Bridge (off-chain) |
| KeeperHub workflow id + hash | *What* exactly runs | KeeperHub (off-chain, deterministic) |
| Zodiac Roles `roleKey` on a Safe | *What is permitted at all* | EVM (on-chain, unforgeable) |
| Limits (caps, venues, window) | *How much, where, when* | Bridge + Roles conditions |

Every run emits a hash-chained **provenance receipt** linking
`strategyHash → remitHash → workflowHash → roleKey → inputsHash → txHash`.

### Naming

The name carries both halves of the product, and the codebase must lean on that rather
than fight it. *Remit* is the noun for a scope of delegated authority, and the verb for
sending value. The tagline is the specification:

> **An agent may remit only within its remit.**

Conventions that follow from it, and which every contributor should hold to:

- The signed document is **a Remit**, never "a mandate", "a policy" or "a config".
- Every G1 rejection code is phrased against the remit:
  `OUT_OF_REMIT`, `REMIT_EXPIRED`, `REMIT_CAP_EXCEEDED`, `REMIT_PRESET_DRIFT`.
- The public CLI uses four verbs and only four:
  `remit issue` (build and sign), `remit serve` (run a strategy under it),
  `remit verify` (check the receipt chain), `remit revoke` (kill switch).
- Packages are `remit-core`, `remit-bridge`, `remit-console`. Published under the
  `@remit/` npm scope, because the bare `remit` package name is almost certainly taken.
- Do not write "Remit Protocol" or "RemitFi". The word alone is the name.

Built for the KeeperHub / DoraHacks hackathon. Two deliverables:

1. **Main track** — the Almanak ↔ KeeperHub integration (this repo).
2. **Bounty** — `packages/keeperhub-safe`, submitted as a pull request to
   `KeeperHub/keeperhub`, closing open issue **#1241 "Safe wallet native integration"**.

---

## 2. Hard rules

These are not style preferences. Violating them invalidates the submission.

### 2.1 No mocks, no stubs, no placeholders

- Never write a function body that returns fabricated data, a hardcoded success, or a
  `TODO`/`NotImplementedError` and then report the task as done.
- Never create fixture files containing invented transaction hashes, invented balances,
  or invented API responses to make a demo look like it works.
- If a dependency is not yet available, stop and say so. Do not simulate it.
- The only acceptable fake chain state is a **local Anvil fork of real mainnet state**
  (`anvil --fork-url $BASE_RPC_URL`). Forked real state is not a mock. Hand-authored
  JSON pretending to be chain state is.
- Tests may use fixtures **only** if those fixtures were captured from a real call and
  the capture script that produced them is committed alongside.

### 2.2 Never invent an address, ABI, selector, or API path

Contract addresses, function signatures, REST paths and SDK method names must be
**verified against a source before use**, and a chain constant is added only together
with the check that re-derives it: `packages/remit-core/scripts/verify-constants.ts`
reads every address in `src/chain/addresses.ts` back off Base and Base Sepolia, and
`submit:check` runs it. A table saying somebody once looked is a weaker fact than the
chain answering today.

Acceptable verification sources, in order of preference:
1. The contract's own deployment on a block explorer (Basescan/Etherscan verified source).
2. The upstream repository at a pinned commit or tag.
3. Official documentation at a URL that resolves right now.

If none of these can be reached, the correct action is to **stop and say so**, not to
guess a plausible value. A plausible wrong address is far worse than a blocked task — it
will move real money to nowhere. `verify:constants` counts a read that never answered
apart from a constant that changed, and exits non-zero for both, for the same reason.

### 2.3 Calldata is never authored by a language model

This is the thesis of the entire project. Enforce it mechanically.

- LLM output may only ever select a **pre-registered workflow id** and fill **typed,
  schema-validated parameters**.
- No code path may accept a raw `data` hex blob, a raw `to` address, or a raw ABI
  string that originated from model output or from a strategy's free-text field.
- The parameter schema lives in `packages/remit-core/src/schema/`. Anything not in
  the schema is rejected at the boundary with a typed error, before any network call.
- If you find yourself writing `encodeFunctionData` with a selector derived from a
  string that came from outside the repo, you have introduced the exact vulnerability
  this project exists to remove. Stop and redesign.

### 2.4 Money safety

- Private keys, Turnkey/Para credentials and API keys never enter the repository,
  never enter a log line, never enter an error message, never enter a commit.
  `.env` is gitignored; `.env.example` lists key names with empty values only.
- Mainnet writes happen only through `ops/scripts/execute-mainnet.ts`, which requires
  the `--confirm` flag and prints the decoded action, the Safe, the roleKey, the value
  and the recipient before proceeding.
- Default network for every script is **Base Sepolia**. Mainnet requires an explicit
  `--network base` argument. There is no "default to mainnet" path anywhere.
- Mainnet demo caps: `perTxCap = 5 USDC`, `dailyCap = 25 USDC`. These live in the
  Remit document and in the Roles preset. Do not raise them to make a test pass.

### 2.5 The four gates must stay independent

An action must pass all four. They are deliberately redundant. Never collapse two
gates into one "for simplicity", and never add a bypass flag.

| Gate | Where | Cost of failure | Failure mode |
|---|---|---|---|
| **G1 Envelope** | `remit-bridge`, pure function | free | Intent outside remit limits → rejected before any I/O |
| **G2 Preflight** | KeeperHub `safe.policy_check` node | one `eth_call` | Roles modifier would revert → typed reason surfaced, no gas spent |
| **G3 Review** | `remit-console` dry-run diff | human time | Operator declines the diff |
| **G4 Chain** | Zodiac Roles v2 `execTransactionWithRole` | gas | EVM reverts. Unforgeable. |

If a change makes G4 the only thing standing between a hallucination and the treasury,
the change is wrong.

### 2.6 No new Solidity

We compose audited contracts (Safe, Zodiac Roles v2) and write **zero custom contracts**.
An unaudited contract written in a five-day sprint and holding funds is a liability, and
judges will read it that way. If a requirement seems to need a new contract, first try to
express it as a Roles v2 condition. Say so out loud before writing any `.sol` file.

---

## 3. Repository layout

```
remit/
├── CLAUDE.md                     # this file
├── DOCS.md                       # technical reference
├── PRD.md                        # product requirements
├── PLAN.md                       # day-by-day execution plan
├── packages/
│   ├── remit-core/             # TypeScript. Schema, EIP-712, compiler, verifier, receipts
│   │   ├── src/schema/           # Zod schemas for Remit + every intent type
│   │   ├── src/eip712/           # typed-data construction and digest
│   │   ├── src/compile/          # Intent -> workflow inputs
│   │   ├── src/verify/           # envelope check (G1), receipt chain verification
│   │   └── test/
│   ├── remit-bridge/           # Python. Almanak strategy adapter + KeeperHub client
│   │   ├── src/remit_bridge/adapters/almanak.py
│   │   ├── src/remit_bridge/keeperhub.py
│   │   ├── src/remit_bridge/receipts.py
│   │   └── tests/
│   ├── remit-console/          # Next.js 15 + React. Review, dry-run diff, ledger, kill switch
│   └── keeperhub-safe/           # BOUNTY. KeeperHub plugin, mirrors keeperhub/plugins/ layout
│       ├── actions/
│       ├── conditions/
│       └── __tests__/
├── ops/
│   ├── roles/                    # Zodiac Roles v2 permission preset build + apply scripts
│   └── scripts/                  # setup-safe, assign-role, kill-switch, execute-mainnet
├── receipts/                     # committed provenance receipts from real runs
└── docs/
    ├── CLAUDE.md                 # this file: the working agreement
    ├── DOCS.md                   # the technical documentation
    ├── PRD.md                    # what is being built, and what it refuses to do
    └── PLAN.md                   # the five days, as they were planned
```

`packages/keeperhub-safe` is developed here but **must remain a clean, self-contained
directory that can be copied into a fork of `KeeperHub/keeperhub` at
`keeperhub/plugins/safe/` without edits**. It must not import from `remit-core` or
anything else in this repo. That is a hard constraint — the bounty PR has to stand alone.

---

## 4. Commands

```bash
# Setup
pnpm install                      # workspace root
uv sync --directory packages/remit-bridge

# Quality gates — all four must pass before any commit
pnpm -r type-check
pnpm -r lint
pnpm -r test
uv run --directory packages/remit-bridge pytest

# Local chain (real forked state, never invented state)
anvil --fork-url $BASE_RPC_URL --chain-id 8453

# Roles preset: build, diff against chain, apply
pnpm --filter ops roles:build
pnpm --filter ops roles:diff    --network base-sepolia
pnpm --filter ops roles:apply   --network base-sepolia

# Console
pnpm --filter remit-console dev

# Bridge, one strategy iteration against a fork
uv run --directory packages/remit-bridge \
  remit serve --strategy <path> --network anvil --once

# Mainnet execution, deliberately awkward
pnpm --filter ops exec --network base --remit <hash> --confirm
```

---

## 5. Conventions

- **TypeScript**: strict mode on, no `any`, no non-null assertions. `viem` for all chain
  interaction — not ethers, not web3.js. `zod` for every external boundary.
- **Python**: 3.12, `uv` for dependency management, `ruff` for lint/format, full type
  annotations, `pydantic` v2 models at every boundary.
- **Errors are typed.** Every rejection returns a discriminated union with a `code`
  (`ENVELOPE_TARGET_NOT_ALLOWED`, `ROLES_CONDITION_VIOLATION`, …) and the specific
  field that failed. Never `throw new Error("failed")`. Judges will test failure paths;
  the error message is part of the product.
- **Structured logging only.** JSON lines with `remitHash`, `executionId`, `gate`,
  `outcome`. No `console.log` of objects. Never log parameter values that contain
  addresses belonging to a real user beyond the demo Safe.
- **Commits**: Conventional Commits. `feat(safe-plugin): …`. The `keeperhub-safe`
  package uses its own scope because those commits get cherry-picked into the PR.
- **No comments that restate the code.** Comment the *why*, especially for every
  security decision.

---

## 6. Glossary

- **Remit** — signed EIP-712 document binding strategy, workflow, role and limits.
  Identified by its digest, `remitHash`.
- **Intent** — a typed, schema-valid action a strategy wants taken. Not calldata.
- **Envelope** — the set of intents a Remit permits. G1 checks membership.
- **Roles Modifier** — Zodiac Roles v2, the Safe module enforcing permissions on-chain.
- **roleKey** — `bytes32` identifier of a role inside the Roles Modifier.
- **Preset** — the declarative permission set (targets, selectors, parameter conditions)
  applied to a roleKey.
- **Preflight** — `eth_call` simulation of `execTransactionWithRole` to learn whether the
  Roles Modifier would revert, without spending gas.
- **Receipt** — hash-chained JSON record of one execution, linking all five hashes.
- **Kill switch** — a single Safe-owner transaction calling `assignRoles` to revoke the
  agent's membership. Instant, total, requires no coordination with us.

---

## 7. Definition of done

A task is done when all of the following are true. Not four of five.

1. `pnpm -r type-check && pnpm -r lint && pnpm -r test` passes, and `pytest` passes.
2. At least one test exercises the **failure** path, not only the happy path.
3. Any new external address is re-derived from chain by `verify:constants`, and any
   new ABI or endpoint is read from a pinned source rather than from memory.
4. No secret, key or credential appears in the diff.
5. The change has been run against a real network (Anvil fork of Base, Base Sepolia, or
   Base mainnet) and the output is pasted into the PR description or the task notes.
6. If it touches an execution path, the four gates are still independent.

---

## 8. Things that will go wrong, and what to do

- **KeeperHub `/execute` response has no `txHash`.** This is known upstream issue #1784.
  Resolve the hash by polling the executions endpoint and correlating by `executionId`.
  Do not guess. If the correlation is ambiguous, fail the receipt rather than write a
  hash you are not sure of. Consider shipping the upstream fix as a second bounty PR.
- **Roles v2 revert reasons are opaque.** Decode them using the error ABI from the
  pinned `gnosisguild/zodiac-modifier-roles` source. Surface the decoded reason in G2;
  an undecoded `0x...` is a failed requirement, not an acceptable output.
- **Almanak SDK surface differs from expectation.** Read the installed package source
  under `.venv/` at the pinned version, and write a test against what is actually
  there. Never code against a remembered API.
- **Base gas spikes mid-demo.** That is a feature, not a bug — it is the reliability
  story. Let KeeperHub's retry and gas escalation handle it and show the run log.
- **You are tempted to widen a limit to make something work.** Don't. Fix the intent
  or the preset, and record why in the commit message.

---

## 9. Out of scope

Do not build these, even if they seem easy:

- Any custom Solidity contract (see 2.6).
- Multi-chain support beyond Base and Base Sepolia.
- A strategy that tries to be profitable. Remit is execution infrastructure; PnL is
  not a judging criterion and chasing it burns the sprint.
- Token, points, or any incentive mechanism.
- User authentication beyond a single operator session on the console.
- Anything that requires an unreleased or invite-only API we cannot access today.
