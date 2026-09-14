# strategies

The strategy side of the integration. One file matters:
`remit_usdc_lender/strategy.py`.

It is an unmodified Almanak `IntentStrategy` at a pinned SDK version
(`almanak==2.28.0`): Almanak's decorator, Almanak's `Intent` objects, Almanak's
`MarketSnapshot`. It has no Remit imports and knows nothing about the Remit, the Safe or
the Roles preset — it would run unchanged against Almanak's own gateway.

That is deliberate. `strategyHash` in every receipt is `keccak256` of this file's bytes,
so a receipt says *which version of this logic* produced a transaction. If the strategy
had to be written to suit us, the provenance claim would be about our fork of somebody's
strategy rather than about theirs.

Its safety comes from nowhere in this directory. It could ask for a withdrawal to an
attacker and the answer would be the same four refusals.

```bash
# hash it into a Remit
pnpm --filter ops remit:issue --network anvil \
  --strategy strategies/remit_usdc_lender/strategy.py \
  --workflow ops/workflows/exec-with-role.workflow.json

# run it against the Remit gateway
uv run --directory packages/remit-bridge remit serve --network anvil --port 50071 &
uv run --directory packages/remit-bridge python -m remit_bridge.drive \
  --network anvil --port 50071 --dry-run
```
