# receipts

Committed provenance receipts from real runs — testnet and mainnet (PRD.md RC-4).

Hash-chained: each record carries `selfHash` over its canonical JSON and `prevHash`
linking to the previous one. `remit verify` re-derives every hash, plus `remitHash` and
`limitsHash` from the stored documents, so a third party can check the chain from a clean
clone with no access to our infrastructure.

One receipt per attempt, rejections and declines included. A run that produced no
transaction still produces a record; that is the point.

Nothing is written here by hand, ever.
