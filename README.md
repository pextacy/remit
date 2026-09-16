# Remit

**An agent may remit only within its remit.**

An AI strategy on [Almanak](https://almanak.co) decides what should happen. A signed
**Remit** bounds what it may do. [KeeperHub](https://app.keeperhub.com) executes it. A
[Zodiac Roles v2](https://github.com/gnosisguild/zodiac-modifier-roles) preset on a
[Safe](https://safe.global) makes exceeding that boundary impossible at the EVM level —
not disallowed, *unrepresentable*. Every attempt, including every refusal, leaves a
hash-chained receipt linking the transaction back to the exact strategy version that
caused it.

The agent proposes, the human bounds, KeeperHub executes deterministically, and the chain
enforces the boundary.

---

## Four gates, and why there are four

```
   Intent                  what the strategy wants, typed. Never calldata.
     │
     ├─ G1  envelope       pure function · free      · refuses before any I/O
     ├─ G2  preflight      one eth_call · no gas     · refuses with a named reason
     ├─ G3  review         a person's attention      · refuses by saying no, or by silence
     └─ G4  chain          gas                       · refuses unforgeably
           │
   execTransactionWithRole → Safe → Aave
```

They are deliberately redundant and deliberately independent. The demonstration that
matters is one poisoned input refused three separate times:

```
G1  REFUSED  OUT_OF_REMIT_RECIPIENT — 0 network calls, no gas
G2  REFUSED  ParameterNotAllowed    — one eth_call, no gas
G4  REVERTED 0x988c6c22…            — 66,979 gas, nothing moved
             the attacker holds 0 USDC
```

If a change would leave G4 as the only thing between a hallucination and the treasury, the
change is wrong.

## The preset is the product

```
Aave.supply(asset, amount, onBehalfOf, referralCode)
  asset       EqualTo USDC
  amount      Pass            ← capped in the Remit, enforced at G1
  onBehalfOf  EqualToAvatar   ← the Safe. This line is the whole talk.
  referralCode Pass
```

`EqualToAvatar` compares against the Safe without naming its address. The agent can move
funds *within* Aave and has no expressible call that moves them *out*. `ExecutionOptions.None`
means no native value and no delegatecall, ever.

## Setup

```bash
pnpm install
pnpm --filter @remit/core build
uv sync --directory packages/remit-bridge
```

Then, against a local fork — real contracts, real state, nobody's money:

```bash
anvil --fork-url https://sepolia.base.org --port 8546
export ANVIL_RPC_URL=http://127.0.0.1:8546

pnpm --filter ops p1 --network anvil          # Safe, Roles, preset, a transaction, a refusal
pnpm --filter ops remit:issue --network anvil \
  --strategy strategies/remit_usdc_lender/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json
pnpm --filter ops fund   --network anvil --usdc 100
pnpm --filter ops nh     --network anvil      # every way this thing refuses
REMIT_NETWORK=anvil pnpm --filter remit-console dev
```

The console is at <http://127.0.0.1:3737>: gate counters, the receipt ledger with its
integrity re-checked on every load, the Remit with its headroom and expiry, the review
queue, and the kill switch. It binds to loopback, because answering G3 is a write and a
server action is a public endpoint whatever the page around it looks like — put it
anywhere reachable and set `REMIT_CONSOLE_TOKEN`, which every decision then has to carry.

## What is where

| | |
|---|---|
| `packages/remit-core` | The Remit, its EIP-712 digest, the intent schemas, the compiler, G1, the receipt chain, the preset. Pure — no clock, no network, no filesystem in the gate |
| `packages/remit-bridge` | Python. Almanak's execution seam, the KeeperHub client, the receipt writer. Calls the core rather than reimplementing it |
| `packages/remit-console` | Next.js. Reads the repository's own files; no database, no API. Five screens, and it names what is wrong rather than going blank |
| `packages/keeperhub-safe` | The upstream contribution: a policy-check node for KeeperHub's Safe plugin |
| `ops` | Safe and Roles deployment, `roles:diff`, the kill switch, the mainnet path |
| `strategies` | An unmodified Almanak strategy with no Remit imports |
| `receipts` | Committed provenance receipts from real runs |
| `docs/VERIFIED.md` | Every external address, ABI and endpoint, with its source and the date it was checked |
| `docs/OPEN_QUESTIONS.md` | What is blocked, and on what |
| `docs/DEMO.md` | The three-minute demo, and how to rehearse it |
| `docs/MAINNET.md` | The mainnet runbook, with measured gas |

## Verify it yourself

```bash
git clone <this repo> && cd remit && pnpm install
uv run --directory packages/remit-bridge remit verify --network base-sepolia
```

Re-derives every hash from the bytes on disk: each receipt's `selfHash`, each `prevHash`
link, and `remitHash` and `limitsHash` from the stored documents. It trusts nothing it is
told, needs no access to anything of ours, and catches an edited receipt, a deleted one,
and an edited one that was re-sealed with a valid hash.

```bash
pnpm --filter @remit/core verify:constants
```

Re-checks every address in `docs/VERIFIED.md` against Base and Base Sepolia.

```bash
pnpm test                                   # the gates and the hashes, as unit tests
uv run --directory packages/remit-bridge pytest tests -q
```

A chain that has outlived one Remit is not a broken chain. Expiry is answered by
reissuing rather than widening, so a long-running deployment's receipts name several — and
`verify` reports those as history, with their hashes and links checked like every other
record, rather than as damage. Documents that *no* record names are a different thing: the
wrong file, and a failure.

The rules, without a chain: G1's whole refusal matrix, canonical JSON, the EIP-712 digest
against a vector foundry produced independently, the receipt chain under each way a chain
can be edited, and the adapter's refusals. They run in seconds on every push, and the
fork-based `gates` job in CI proves the same rules against real contracts.

## Transaction links

| | |
|---|---|
| Base mainnet | **not yet** — see `docs/OPEN_QUESTIONS.md` OQ-9. It needs a funded key and a KeeperHub account; the sequence is rehearsed and the runbook is `docs/MAINNET.md` |
| Base Sepolia | **done**, 2026-09-15. A Safe, a Roles instance, the preset applied, a signed Remit, and two transactions through all four gates: [approve](https://sepolia.basescan.org/tx/0xfe9956529b424f4f4d2b0c5d933af4f766942b3952b3514eca6a4b71931c75cd) and [supply](https://sepolia.basescan.org/tx/0x07a6c02ea37409df83315651ff6ca5426eb3f575a10798dc0ceca25e34cc7b16). Safe [`0x4e67…87d1`](https://sepolia.basescan.org/address/0x4e67371BA5cA46BF64a2B91c7b51bB8b0bfC87d1), Roles [`0xe877…FA68`](https://sepolia.basescan.org/address/0xe8777944e78B34e788f57a340Ea85F3D7c04FA68), Remit `0x21297f43…`. The receipt chain is in `receipts/base-sepolia/` and verifies from a clean clone |
| Bounty issue / PR | drafted and unposted in `packages/keeperhub-safe/`; upstream requires an accepted issue first |

Those gaps are stated here rather than papered over. Everything above them runs today
against a fork of the real chains, and `docs/VERIFIED.md` records what was checked, how,
and when.

## G3 is a gate, not a note

An action above the Remit's `requireReviewAboveUsd` stops and waits for a person. Both
paths do it — the ops pipeline and the bridge a strategy talks to — on the same queue, a
directory of JSON files the console reads.

Three rules, and the second is the one that makes it a gate:

- **Silence is a refusal.** A review that times out into an approval is not a review.
- **No reviewer is a refusal.** With no queue configured the action stops before G2, for
  free, and the receipt says nobody could look. `--no-review` still exists, has to be
  typed, and puts "nobody looked" in the chain rather than leaving G3 out of it.
- **Named parameters, never calldata.** An operator asked to approve a hex blob is being
  asked to rubber-stamp, and a gate that produces rubber-stamping launders the decision
  instead of making it.

## One proposal at a time

The daily cap is a read-modify-write: what the ledger already holds, plus this action. It
is correct exactly once. Between G1's decision and the ledger entry that records it sit a
preflight, possibly a human, and a transaction — so two proposals running at once each see
a day in which the other has spent nothing, and a 25 USD cap becomes 25 USD per process.

The whole gated path is therefore one critical section, per network, held on a lock file
that the ops scripts and the Python bridge both take. Waiting is bounded and failure is a
refusal: a cap counted against a history somebody else is still changing is not a cap. The
`gates` job in CI runs two proposals of 0.6 USD against a 1 USD day and asserts that
exactly one lands.

## What still breaks

The Remit's signature is verified off chain only; the on-chain authority is the Roles
preset, so a Remit can narrow authority but cannot enforce itself. An on-chain Remit
registry is the right fix and was deliberately left out rather than shipping an unaudited
contract in five days. `workflowHash` binds a document KeeperHub has not seen yet.
Three intent kinds. Base only.
