# The mainnet run

The submission needs one thing that nothing else can substitute for: a transaction on
**Base mainnet**, executed through KeeperHub, out of the demo Safe, through
`execTransactionWithRole`. This is the runbook for it.

**Status: not done.** It needs a funded key and a KeeperHub account, and neither exists in
the build environment (docs/OPEN_QUESTIONS.md OQ-1, OQ-6). Everything else is done and
rehearsed: the sequence below was run end to end on a fork of Base mainnet on 2026-09-14,
against chain 8453's real contracts, real USDC and the real Aave v3 pool, and it worked.

---

## What it costs

Measured from the rehearsal, priced at the Base gas price observed on 2026-09-14
(0.006 gwei):

| Step | Gas | At 0.006 gwei |
|---|---|---|
| Deploy the Safe | 306,183 | 0.0000018 ETH |
| Deploy the Roles instance | 191,158 | 0.0000011 ETH |
| Enable the module | 107,518 | 0.0000007 ETH |
| Assign the agent to the role | 126,786 | 0.0000008 ETH |
| Apply the preset (5 owner transactions) | 742,144 | 0.0000045 ETH |
| `approve` through the role | 114,110 | 0.0000007 ETH |
| `supply` through the role | 285,436 | 0.0000017 ETH |
| **Total** | **1,873,335** | **~0.0000112 ETH** |

Gas is not the constraint on Base. Fund the owner EOA with ~0.002 ETH for headroom, the
agent EOA with ~0.001 ETH (only needed on the ops-direct path — KeeperHub pays its own),
and the Safe with **30 USDC**: enough for a 5 USDC action with room to repeat it, and
inside the 25 USDC daily cap.

## Before anything

```bash
pnpm --filter ops mainnet:preflight --network base
```

Sixteen checks, all of which must pass. It reads only, so run it before every attempt
rather than once. It is the difference between finding out the Safe is empty now and
finding out at 23:00 on Thursday.

What it will not let you skip: the agent must not be a Safe owner (a key that proposes
must not be able to rewrite what it may propose), the preset must be applied with **zero**
drift from the Remit, the caps must be 5 and 25, and `KEEPERHUB_API_KEY` must be set —
because the product path is KeeperHub and there is no fallback.

## The sequence

```bash
export BASE_RPC_URL=…                # required; there is no default for mainnet
export SAFE_OWNER_1_PRIVATE_KEY=…    # hot
export SAFE_OWNER_2_PRIVATE_KEY=…    # hot
export SAFE_OWNER_3_ADDRESS=…        # cold — a key we do not hold
export AGENT_SIGNER_PRIVATE_KEY=…    # never an owner
export KEEPERHUB_API_KEY=kh_…

# 1. a Safe and a Roles instance, separate from the testnet ones
pnpm --filter ops safe:deploy  --network base --salt remit-mainnet --confirm
pnpm --filter ops roles:deploy --network base --salt remit-mainnet --confirm

# 2. read the preset before applying it, then apply it
pnpm --filter ops roles:build --network base
pnpm --filter ops roles:diff  --network base
pnpm --filter ops roles:apply --network base --confirm --yes

# 3. fund the Safe with 30 USDC by hand, from a wallet you control

# 4. issue the Remit against the strategy and the workflow
pnpm --filter ops remit:issue --network base \
  --strategy strategies/remit_usdc_lender/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json

pnpm --filter ops remit:verify-digest --network base
pnpm --filter ops mainnet:preflight   --network base

# 5. the proof transaction
pnpm --filter ops exec:mainnet --network base \
  --remit 0x… --kind approve --amount 5 --confirm
pnpm --filter ops exec:mainnet --network base \
  --remit 0x… --kind supply  --amount 5 --confirm

# 6. commit what it produced
uv run --directory packages/remit-bridge remit verify --network base
git add receipts/base ops/deployments/base.json ops/remits/base.json
```

`exec:mainnet` asks for four separate acts of intent before it sends: the network named,
`--confirm`, the Remit named **by hash** and checked against the issued document, and the
decoded action — Safe, roleKey, value, recipient, caps, headroom — printed in front of
you. Read the block. It is there because the transaction after it cannot be taken back.

## Rehearsing it

The same commands, against a fork of Base mainnet, with real state and nobody's money:

```bash
anvil --fork-url https://mainnet.base.org --port 8547
export ANVIL_BASE_RPC_URL=http://127.0.0.1:8547

pnpm --filter ops safe:deploy  --network anvil-base --salt remit-mainnet
pnpm --filter ops roles:deploy --network anvil-base --salt remit-mainnet
pnpm --filter ops roles:apply  --network anvil-base
pnpm --filter ops fund         --network anvil-base --usdc 30
pnpm --filter ops remit:issue  --network anvil-base \
  --strategy strategies/remit_usdc_lender/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json
pnpm --filter ops mainnet:preflight --network anvil-base
pnpm --filter ops exec:mainnet --network anvil-base --remit 0x… \
  --kind supply --amount 5 --confirm
```

`anvil-base` is chain 8453: the preset it builds uses mainnet's USDC
(`0x833589fC…`) and mainnet's Aave pool (`0xA238Dd80…`), so the rehearsal exercises the
addresses the real run will use. The Safe is funded by impersonating a contract that holds
real USDC and transferring some — forked real state, moved by its real holder.

The flags are not skipped in rehearsal. A path only ever practised without its ceremony is
a path nobody has practised.

## When it is done

The submission needs the Basescan link in three places: the DoraHacks form, the README,
and a committed receipt under `receipts/base/`. The receipt is the one that matters — it
carries `strategyHash → remitHash → workflowHash → roleKey → txHash`, and anybody can
re-derive every one of them from a clean clone.
