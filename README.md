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
     ├─ G3  review         a person's attention      · refuses by saying no
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

The console is at <http://localhost:3737>: gate counters, the receipt ledger with its
integrity re-checked on every load, the Remit with its headroom and expiry, the review
queue, and the kill switch.

## What is where

| | |
|---|---|
| `packages/remit-core` | The Remit, its EIP-712 digest, the intent schemas, the compiler, G1, the receipt chain, the preset. Pure — no clock, no network, no filesystem in the gate |
| `packages/remit-bridge` | Python. Almanak's execution seam, the KeeperHub client, the receipt writer. Calls the core rather than reimplementing it |
| `packages/remit-console` | Next.js. Reads the repository's own files; no database, no API |
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

## Transaction links

| | |
|---|---|
| Base mainnet | **not yet** — see `docs/OPEN_QUESTIONS.md` OQ-9. It needs a funded key and a KeeperHub account; the sequence is rehearsed and the runbook is `docs/MAINNET.md` |
| Base Sepolia | **not yet** — OQ-6, same cause |
| Bounty issue / PR | drafted and unposted in `packages/keeperhub-safe/`; upstream requires an accepted issue first |

Those gaps are stated here rather than papered over. Everything above them runs today
against a fork of the real chains, and `docs/VERIFIED.md` records what was checked, how,
and when.

## What still breaks

The Remit's signature is verified off chain only; the on-chain authority is the Roles
preset, so a Remit can narrow authority but cannot enforce itself. An on-chain Remit
registry is the right fix and was deliberately left out rather than shipping an unaudited
contract in five days. `workflowHash` binds a document KeeperHub has not seen yet.
Three intent kinds. Base only.
