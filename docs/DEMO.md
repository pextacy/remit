# The demo

Three minutes, run live, twice, on somebody else's network, with a judge interrupting.
Everything below is a command that works today against a fork — no slides, no recording
tricks, and nothing that only works the first time.

**Rehearse it until it is boring.** The one thing that must not happen on the call is
discovering that a step needs a chain that is not running.

## Before the call

```bash
anvil --fork-url https://sepolia.base.org --port 8546 &
export ANVIL_RPC_URL=http://127.0.0.1:8546

pnpm install && pnpm --filter @remit/core build
uv sync --directory packages/remit-bridge

pnpm --filter ops p1 --network anvil
pnpm --filter ops remit:issue --network anvil \
  --strategy strategies/remit_usdc_lender/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json
pnpm --filter ops fund --network anvil --usdc 100

# Aave pulls the USDC, so the Safe has to have approved the pool. `p1` runs an approve of
# its own and then spends it on its own supply, and `fund` adds USDC without adding an
# allowance — so without this line the 0:20 step fails with `ModuleTransactionFailed`:
# the role allows the call and Aave refuses it. That is a true refusal about the wrong
# thing, on the one step whose point is that it works.
pnpm --filter ops run exec --network anvil --action approve --amount 100

REMIT_NETWORK=anvil pnpm --filter remit-console dev &   # http://localhost:3737
```

Two terminals and a browser. Nothing else.

---

## 0:00 — the boundary (20s)

Console → **Remit**.

> The Safe holds the funds. This is the authority the agent was given. Read one line:
> `value may land at` — the Safe, and nothing else.

```bash
pnpm --filter ops roles:build --network anvil
```

> And here is the same thing on chain. `onBehalfOf EqualToAvatar`. That is the whole
> talk: the agent can move funds *within* Aave and has no expressible call that moves
> them *out*.

## 0:20 — it works (30s)

```bash
pnpm --filter ops run exec --network anvil --action supply --amount 5
```

> G1 passes for free. G2 asks the Roles modifier whether it would allow this — one
> `eth_call`, no gas. Then it executes. Transaction hash, and a receipt.

Console → **Ledger**. Point at the row and at `chain intact`.

## 0:50 — now poison it (50s) — *the centrepiece*

```bash
pnpm --filter ops nh --network anvil --case injection
```

> Same strategy, crafted input, funds redirected to an attacker.
>
> **G1 refuses in microseconds — zero network calls.** Not "we didn't make one"; the
> runner counts them.
>
> Ask the next gate the same question. **G2 refuses with a name** — `ParameterNotAllowed`,
> from the modifier's own `Status` enum. One `eth_call`, no gas.
>
> Send it anyway. **The chain reverts.** 67,000 gas, and the attacker's balance is still
> zero.
>
> Three receipts. Three independent refusals. No flag anywhere skips a gate — these are
> three separate functions being asked the same question.

## 1:40 — the receipt chain (30s)

Console → **Ledger**, then:

```bash
uv run --directory packages/remit-bridge remit verify --network anvil
```

> Strategy version → Remit → workflow → role → transaction hash. Every hash re-derived
> from the bytes on disk. Run it from a clean clone with no access to anything of ours —
> it catches an edited receipt, a deleted one, and an edited one re-sealed with a valid
> hash, because the next record still points at what the old one was.

## 2:10 — the kill switch (25s)

Console → **Kill switch**. Show `agent authority: active`, then:

```bash
pnpm --filter ops kill --network anvil
```

> One owner transaction. Re-read the page: `revoked`. The next preflight says
> `NoMembership()`.
>
> Nothing in our stack was consulted to achieve that. If we disappeared, the switch still
> works.

```bash
pnpm --filter ops kill --network anvil --restore
```

## 2:35 — upstream and mainnet (25s)

> `packages/keeperhub-safe` is the contribution: a policy-check node for KeeperHub's own
> Safe plugin, closing a gap their own source documents. It type-checks inside their repo
> and their Safe tests pass with it.
>
> The mainnet run is rehearsed against a fork of Base — `docs/MAINNET.md`, with measured
> gas — and the transaction itself is waiting on a funded key. That is stated in the
> README rather than implied away.

---

## Questions to have answers ready for

**What stops KeeperHub itself from draining the Safe?**
The preset. KeeperHub holds a signer that is a member of a role scoped to two functions
with the recipient pinned to the Safe. Worst case is griefing, not theft.

**Why not put the Remit on chain?**
Because an unaudited contract written in five days holding funds is worse than an honest
off-chain document over an audited preset. It is named as a limitation in the submission
rather than hidden.

**What is actually new here?**
The provenance receipt. Almanak scopes permissions and KeeperHub keeps an audit trail, but
nothing today links a transaction hash back to the exact strategy version and the authority
it acted under, verifiably, by a third party. We also refuse to write a hash we are not
sure of: an ambiguous correlation produces a receipt with no hash rather than a plausible
wrong one.

**Why Roles instead of a Safe guard or a session key?**
Roles v2 is audited, in production at ENS DAO and GnosisDAO, and expresses per-parameter
conditions — which is what pins the recipient. A guard can only say yes or no to a whole
transaction.

**Did you bypass your own gates for that demo?**
No. There is no bypass flag; CLAUDE.md §2.5 forbids one. The gates are independent
functions and the scenario runner asks each directly. Nothing in it is reachable from the
paths that execute.

**Is that a real transaction?**
On a fork of the real chain, with the real contracts and real state — and the receipt says
which network it was. The mainnet one is not done, and `docs/OPEN_QUESTIONS.md` says so.

## The video

Three minutes, this script, one take. Record it on **Thursday**, not Friday — the day you
think you have spare is the day the RPC key expires.
