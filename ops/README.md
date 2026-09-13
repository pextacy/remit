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
pnpm --filter ops roles:apply   --network base-sepolia
pnpm --filter ops status        --network base-sepolia

pnpm --filter ops run exec --network base-sepolia --action approve  --amount 50
pnpm --filter ops run exec --network base-sepolia --action supply   --amount 50
pnpm --filter ops run exec --network base-sepolia --action withdraw --amount 10

# the refusals
pnpm --filter ops run exec --network base-sepolia --action withdraw --amount 10 --violate
pnpm --filter ops run exec --network base-sepolia --action transfer --amount 10
pnpm --filter ops run exec --network base-sepolia --action supply --amount 10 --target 0x…
pnpm --filter ops run exec --network base-sepolia --action withdraw --amount 10 --violate --force

# the kill switch
pnpm --filter ops role:assign --network base-sepolia --revoke
```

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

## Rules that predate the code

- **Base Sepolia is the default.** `--network base` additionally requires `--confirm`, and
  says out loud that it is about to move real money. There is no path that reaches mainnet
  by accident.
- **Print the preset before applying it.** `roles:diff` in P4 turns that into a real diff
  against what is already on chain; until then `roles:build` prints what is about to be
  applied, and someone who did not write it reads it.
- **No key lives in the repository.** On a fork, addresses are impersonated and no key
  exists at all. On a real network the keys come from `.env`, which is gitignored, and the
  agent signer is a different variable from the owner keys — an agent key that is also an
  owner key makes every gate downstream decorative.
- **Preflight first, always.** Every execution simulates `execTransactionWithRole` with
  `shouldRevert = true` before sending. It costs no gas and returns a name. `--force`
  exists only to record the on-chain half of a refusal that preflight already predicted.
