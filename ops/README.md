# ops

Everything that touches a chain: the Safe, the Zodiac Roles instance, the preset, the
kill switch, and the deliberately awkward mainnet path.

## The whole of P1 in one command

```bash
anvil --fork-url https://sepolia.base.org --port 8546
ANVIL_RPC_URL=http://127.0.0.1:8546 pnpm --filter ops p1 --network anvil
```

Deploys a 2-of-3 Safe, deploys and enables a Roles v2 instance, assigns the agent signer,
applies the preset, funds the Safe, moves value, then asks for four things the preset does
not allow and checks that each is refused with the *right* name. Ends by pulling the kill
switch and restoring it. Exits non-zero if any of that is untrue.

A fork of Base Sepolia is real state and real contracts, which is why it is the only
acceptable substitute for the testnet (CLAUDE.md §2.1). It is not a substitute for the
testnet transaction hash P1's exit gate asks for — that needs funded keys, see
`docs/OPEN_QUESTIONS.md` OQ-6.

## The same thing, one step at a time

```bash
pnpm --filter ops safe:deploy   --network base-sepolia
pnpm --filter ops roles:deploy  --network base-sepolia
pnpm --filter ops roles:build   --network base-sepolia   # print it, and read it
pnpm --filter ops roles:diff    --network base-sepolia   # what would change, and what widens
pnpm --filter ops roles:apply   --network base-sepolia   # runs the diff first, always
pnpm --filter ops status        --network base-sepolia

pnpm --filter ops run exec --network base-sepolia --action approve  --amount 50
pnpm --filter ops run exec --network base-sepolia --action supply   --amount 50
pnpm --filter ops run exec --network base-sepolia --action withdraw --amount 10

# the refusals
pnpm --filter ops run exec --network base-sepolia --action withdraw --amount 10 --violate
pnpm --filter ops run exec --network base-sepolia --action transfer --amount 10
pnpm --filter ops run exec --network base-sepolia --action supply --amount 10 --target 0x…
pnpm --filter ops run exec --network base-sepolia --action withdraw --amount 10 --violate --force

# narrow one thing without switching the agent off
pnpm --filter ops roles:revoke --network base-sepolia \
  --function "withdraw(address,uint256,address)" --on 0x…

# the kill switch: one owner transaction, with a receipt for the state either side
pnpm --filter ops kill --network base-sepolia
pnpm --filter ops kill --network base-sepolia --restore
```

## Mainnet

The runbook, the measured costs and the preconditions are in **docs/MAINNET.md**. The
short version:

```bash
pnpm --filter ops mainnet:preflight --network base    # sixteen checks, all must pass
pnpm --filter ops exec:mainnet --network base \
  --remit 0x… --kind supply --amount 5 --confirm
```

Rehearse it against a fork of Base mainnet first — same addresses, same preset, same
ceremony, nobody's money:

```bash
anvil --fork-url https://mainnet.base.org --port 8547
export ANVIL_BASE_RPC_URL=http://127.0.0.1:8547
pnpm --filter ops safe:deploy --network anvil-base --salt remit-mainnet
# … see docs/MAINNET.md
```

Four separate acts of intent before anything is sent: the network named explicitly,
`--confirm`, the Remit named **by hash** and checked against the document issued for this
deployment, and the decoded action — Safe, roleKey, value, recipient, caps, headroom —
printed in front of you first. It runs the same pipeline as `propose`; a mainnet path with
its own copy of the gates is a mainnet path nobody has rehearsed, so rehearse it with
`--network anvil`, flags and all.

Read-only scripts (`roles:diff`, `roles:build`, `status`, `g1`) do not need `--confirm` on
mainnet. Making an operator type it to *look* at something teaches them to type it without
reading.

`exec` needs `pnpm run exec` rather than bare `pnpm exec`, which pnpm reserves for itself.

Addresses land in `ops/deployments/<network>.json`. The fork file is gitignored because it
is regenerated on every run; a real deployment is evidence and is committed.

## The Remit, and the gates in front of it

```bash
# issue one — both hashes come from real files, there is no placeholder
pnpm --filter ops remit:issue --network anvil \
  --strategy path/to/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json

# re-derive remitHash with foundry, independently of viem
pnpm --filter ops remit:verify-digest --network anvil

# run G1 over every refusal it knows how to make
pnpm --filter ops g1 --network anvil

# an intent, through G1 → G2 → the chain
pnpm --filter ops propose --network anvil --kind supply   --amount 5
pnpm --filter ops propose --network anvil --kind withdraw --amount 2 --to 0x…
```

`propose` is the shape the bridge takes in P3, minus KeeperHub: the two gates in front of
execution do not change when the last step stops being a direct send. A G1 refusal makes
no network call at all; a G2 refusal costs one `eth_call` and no gas.

The rolling spend ledger lives at `ops/deployments/<network>.ledger.json` and is appended
only when value actually moved — a cap consumed by a call that spent nothing would tighten
every time the chain said no.

Every `propose` run leaves a receipt in `receipts/<network>/`, whichever gate decided. The
chain is checked from the other side of the process boundary:

```bash
uv run --directory packages/remit-bridge remit verify --network anvil
```

`submission.path` in each receipt says `ops-direct` for this script, because the agent
signer calls the Roles Modifier itself. The product path is `keeperhub`, and it is the
bridge's (`remit run`), which stops rather than falling back when there is no API key.

## The failure surface

```bash
pnpm --filter ops nh --network anvil                 # all seven, plus the injection story
pnpm --filter ops nh --network anvil --case nh2
pnpm --filter ops nh --network anvil --case injection
```

Every non-happy-path requirement in PRD.md §5.11, demonstrated and recorded into the same
receipt chain as a real run. NH-1 counts the RPC requests it makes so that "no network
call" is evidence rather than a claim; NH-7 reports what concurrency on this path actually
does, which is collide, because that is the problem KeeperHub's nonce management exists to
solve.

There is no bypass flag anywhere (CLAUDE.md §2.5). The gates are independent functions and
this runner asks each one directly — that is how the injection scenario shows the second
gate catching what the first would have caught. Nothing in it is reachable from `propose`,
`exec:mainnet` or `remit serve`.

## Rules that predate the code

- **Base Sepolia is the default.** `--network base` additionally requires `--confirm`, and
  says out loud that it is about to move real money. There is no path that reaches mainnet
  by accident.
- **Diff before apply.** `roles:apply` runs `roles:diff` itself and refuses when there is
  nothing to do; on mainnet it refuses a widening without `--yes`. The diff is a real one:
  it replays the Roles Modifier's own events to reconstruct what the chain currently says,
  because Roles 2.1.0 exposes no getter for a role's scope. Someone who did not write the
  preset reads the output.
- **No key lives in the repository.** On a fork, addresses are impersonated and no key
  exists at all. On a real network the keys come from `.env`, which is gitignored, and the
  agent signer is a different variable from the owner keys — an agent key that is also an
  owner key makes every gate downstream decorative.
- **Preflight first, always.** Every execution simulates `execTransactionWithRole` with
  `shouldRevert = true` before sending. It costs no gas and returns a name. `--force`
  exists only to record the on-chain half of a refusal that preflight already predicted.
