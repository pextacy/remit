# receipts

Committed provenance receipts from real runs — testnet and mainnet (PRD.md RC-4).

One record per attempt, whatever the outcome. A refusal at G1 produces a receipt, a
refusal at G2 produces a receipt, and so does a transaction that reverted. A log that
only contains what worked is a log that has been edited.

Each record carries the five hashes that make it checkable —
`strategyHash → remitHash → workflowHash → roleKey → txHash` — plus `selfHash` over its
own canonical bytes and `prevHash` linking to the record before it.

## Checking them

```bash
uv run --directory packages/remit-bridge remit verify --network base-sepolia
```

Re-derives every hash from the bytes on disk: each `selfHash`, each `prevHash` link, and
`remitHash` and `limitsHash` from the stored Remit documents. It trusts nothing it is told.
Run it from a clean clone, by someone with no access to our infrastructure — that is
acceptance criterion 3, and the reason the storage layer is a directory of JSON files
rather than a database somebody has to be given access to.

Three ways to break a chain, all of them caught:

| Tamper | What verification says |
|---|---|
| Edit a field, leave the hash | `selfHash does not match the receipt's own bytes` |
| Delete a record from the middle | `sequence is out of order` and `prevHash does not link` |
| Edit a field *and* re-seal it with a correct hash | `prevHash does not link to the previous receipt` — the next record still points at the old one |

## What is committed here

Receipts from **Base Sepolia and Base mainnet**. Receipts from a local Anvil fork are
gitignored: they are real records of real contract execution, but they name a Safe that
does not exist on the public chain, and a reader cannot tell that from the file. Reproduce
them with `pnpm --filter ops p1 --network anvil` and the `propose` commands in `ops/README.md`.

`submission.path` says which route submitted a transaction: `keeperhub` is the product
path, `ops-direct` is the operator's hand-run path from P1, and `none` means nothing was
submitted. No receipt can imply KeeperHub executed something it never saw.

Nothing is written here by hand, ever.
