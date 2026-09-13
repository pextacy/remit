# Remit — Technical Documentation

**An agent may remit only within its remit.**

Bounded-authority execution for onchain AI agents.
Almanak decides. KeeperHub executes. Safe holds. Zodiac Roles enforces.

---

## 1. Problem

An LLM-driven DeFi strategy is probabilistic at exactly the moment determinism matters
most: the instant it constructs a transaction. Three failure classes recur:

1. **Reinterpretation.** The same instruction produces different calldata on different
   runs. "Rebalance to 60/40" becomes a different set of calls each time.
2. **Scope creep by injection.** A poisoned price feed, a malicious token name, a crafted
   forum post ingested as context — any of these can steer an agent into an action its
   operator never sanctioned.
3. **No provenance.** After the fact, nobody can answer "which version of which strategy
   produced this transaction, and was it allowed to?" with anything stronger than a log
   line the agent itself wrote.

Existing mitigations address one layer each. Almanak scopes Safe permissions per strategy.
KeeperHub removes execution-time inference and adds retries, nonce management, private
routing and an audit trail. Zodiac Roles enforces permissions on-chain. None of them, on
their own, produces a verifiable chain from *decision* to *transaction*.

Remit composes all three and adds the missing link: the **provenance receipt**.

---

## 2. Core concept: the Remit

A Remit is a signed document. It is the unit of delegated authority.

```
Remit
├── strategyHash    keccak256 of the Almanak strategy source at a pinned version
├── workflowHash    keccak256 of the canonicalised KeeperHub workflow definition
├── safe            address of the Safe holding funds
├── rolesModifier   address of the Zodiac Roles v2 instance attached to that Safe
├── roleKey         bytes32 role the agent's signer is a member of
├── limitsHash      keccak256 of the canonical JSON limits object
├── chainId         uint256
├── notBefore       uint64  unix seconds
├── notAfter        uint64  unix seconds
└── nonce           uint256  monotonic per (safe, roleKey)
```

`remitHash` is the EIP-712 digest of the struct above. It is the primary key of the
entire system: receipts reference it, the console displays it, the bridge refuses to act
without one.

### 2.1 EIP-712 typed data

```
domain = {
  name:              "Remit",
  version:           "1",
  chainId:           <8453 | 84532>,
  verifyingContract: <Safe address>
}

Remit(
  bytes32 strategyHash,
  bytes32 workflowHash,
  address safe,
  address rolesModifier,
  bytes32 roleKey,
  bytes32 limitsHash,
  uint256 chainId,
  uint64  notBefore,
  uint64  notAfter,
  uint256 nonce
)
```

`verifyingContract` is the Safe because the Safe is the authority being delegated from.
The digest is signed by Safe owners as plain EOA `personal_sign`-free `eth_signTypedData_v4`
signatures. There is no on-chain verification of these signatures and that is deliberate:
**the Remit signature is an off-chain declaration of intent; the on-chain truth is the
Roles configuration.** A Remit cannot grant authority that the Roles preset does not
already grant. It can only narrow.

This is why the project needs no custom contract.

### 2.2 Limits object

Canonical JSON, sorted keys, no whitespace, hashed with keccak256.

```json
{
  "perTxCapUsd": "5",
  "dailyCapUsd": "25",
  "maxSlippageBps": 50,
  "allowedTargets": ["<verified token address>", "<verified pool address>"],
  "allowedSelectors": ["approve(address,uint256)", "supply(address,uint256,address,uint16)"],
  "allowedRecipients": ["<the Safe address>"],
  "maxTxPerHour": 6,
  "requireReviewAboveUsd": "1"
}
```

Two properties matter:

- `allowedRecipients` containing only the Safe itself means the agent can move funds
  *within* approved protocols but cannot move them *out*. Exfiltration is structurally
  impossible, not merely disallowed.
- `requireReviewAboveUsd` is the G3 threshold. Below it, execution is autonomous; above
  it, a human sees the dry-run diff first.

Every field here has a counterpart in the Roles preset (section 5). The bridge asserts
they agree at startup and refuses to run if they drift.

---

## 3. The four gates

An intent must pass all four. They fail in increasing order of cost.

### G1 — Envelope check (free, pure function)

`packages/remit-core/src/verify/envelope.ts`

Input: a typed `Intent`, the Remit, the rolling spend ledger.
Checks: intent type is in the remit's allowed set; target ∈ `allowedTargets`;
selector ∈ `allowedSelectors`; recipient ∈ `allowedRecipients`; notional ≤ `perTxCapUsd`;
rolling 24h notional + notional ≤ `dailyCapUsd`; `notBefore ≤ now ≤ notAfter`;
rate limit not exceeded.

Output: `{ ok: true, compiled: WorkflowInputs }` or
`{ ok: false, code: EnvelopeErrorCode, field: string, expected: string, actual: string }`.

No network access. Runs in microseconds. This is where a prompt injection dies.

### G2 — Preflight (one `eth_call`, no gas)

KeeperHub node `safe.policy_check` (shipped in the bounty plugin).

Performs `eth_call` of:

```solidity
execTransactionWithRole(
  address to,
  uint256 value,
  bytes   data,
  Enum.Operation operation,   // 0 = Call
  bytes32 roleKey,
  bool    shouldRevert        // true
)
```

from the agent's signer address against the Roles Modifier. `shouldRevert = true` makes
the modifier revert with a typed error rather than returning `false`, so the exact
condition that failed is recoverable.

Revert data is decoded against the Roles v2 error ABI and returned as
`{ allowed: false, reason: "ParameterNotAllowed", parameterIndex: 2 }`.

This tells the operator *why* the chain would refuse, before any gas is spent — the
single most useful thing this project gives a treasury operator.

### G3 — Human review (dry run diff)

`remit-console`. Triggered when notional > `requireReviewAboveUsd`, or when the strategy
version hash has changed since the last approved run, or on operator demand.

The console renders, side by side:
- the decoded action (target contract name, function, each parameter with its meaning)
- the simulated balance delta for the Safe, from an Anvil fork at the current block
- the Remit's limits and how much headroom this action consumes
- the G2 result

The operator approves or declines. A decline is recorded in the receipt chain as a
terminal receipt with `outcome: "declined"`. Declines are part of the audit trail.

### G4 — On-chain enforcement (gas, unforgeable)

KeeperHub node `safe.exec_with_role` submits the real transaction. The Zodiac Roles
Modifier v2 re-evaluates every condition in the preset. If the transaction does not match
the preset, the EVM reverts. No off-chain component can override this.

G1–G3 exist to make G4 never fire in normal operation. G4 exists because G1–G3 are
software written by humans in five days.

---

## 4. Architecture and data flow

```
┌──────────────────────────────────────────────────────────────────────┐
│ Almanak strategy (pinned version, Python)                            │
│   produces: StrategyAction                                           │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────┐
│ remit-bridge  (Python)                                             │
│   1. map StrategyAction -> typed Intent (pydantic, schema-validated)  │
│   2. G1 envelope check against the Remit                           │
│   3. compile Intent -> named workflow id + typed inputs              │
│      (never raw calldata)                                            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  POST /api/workflows/{id}/execute
┌──────────────────────────▼───────────────────────────────────────────┐
│ KeeperHub                                                            │
│   node: safe.read_state      (owners, threshold, nonce, modules)     │
│   node: safe.policy_check    G2 preflight, eth_call, decoded reason  │
│   node: <review gate>        webhook out to console if above threshold│
│   node: safe.exec_with_role  G4, submits via Roles modifier          │
│   platform: nonce mgmt, gas escalation, private routing, retries     │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  execTransactionWithRole(...)
┌──────────────────────────▼───────────────────────────────────────────┐
│ Zodiac Roles Modifier v2  ──enabled module on──▶  Safe (funds)       │
│   evaluates preset conditions; reverts on any mismatch               │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  txHash, block, gasUsed
┌──────────────────────────▼───────────────────────────────────────────┐
│ receipts/  hash-chained provenance records                           │
└──────────────────────────────────────────────────────────────────────┘
```

Kill switch runs orthogonally: any Safe owner calls `assignRoles(agentSigner, [roleKey],
[false])` on the Roles Modifier. The agent's authority is gone in one transaction, with no
cooperation from Remit, Almanak or KeeperHub required.

---

## 5. Zodiac Roles v2 preset

The preset is the on-chain expression of the Remit limits. It is built declaratively in
`ops/roles/preset.ts` and applied with `roles:apply`.

Shape of a minimal Aave-supply preset on Base:

```
scopeTarget(roleKey, USDC)
scopeFunction(roleKey, USDC, "approve(address,uint256)", [
   param 0 (address spender)  EqualTo  AAVE_POOL
   param 1 (uint256 amount)   LessThanOrEqualTo  perTxCap
], ExecutionOptions.None)

scopeTarget(roleKey, AAVE_POOL)
scopeFunction(roleKey, AAVE_POOL, "supply(address,uint256,address,uint16)", [
   param 0 (address asset)     EqualTo  USDC
   param 1 (uint256 amount)    LessThanOrEqualTo  perTxCap
   param 2 (address onBehalfOf) EqualTo  SAFE        // funds can only land back in the Safe
   param 3 (uint16 referral)   EqualTo  0
], ExecutionOptions.None)

scopeFunction(roleKey, AAVE_POOL, "withdraw(address,uint256,address)", [
   param 0 EqualTo USDC
   param 2 EqualTo SAFE                              // withdrawal recipient is pinned
], ExecutionOptions.None)

assignRoles(AGENT_SIGNER, [roleKey], [true])
setDefaultRole(AGENT_SIGNER, roleKey)
```

`param 2 EqualTo SAFE` on both `supply` and `withdraw` is the load-bearing line. It is the
reason "send everything to the attacker" cannot succeed even if every off-chain component
is compromised simultaneously.

`ExecutionOptions.None` forbids both native value transfer and delegatecall for this role.
Delegatecall is never enabled for an agent role under any circumstance.

### 5.1 Contract references

These must be verified against a block explorer before first use and recorded in
`docs/VERIFIED.md` with the date and source. Do not copy them from here into code without
that verification step.

| Contract | Notes |
|---|---|
| Zodiac Roles Modifier v2 mastercopy | `0x9646fDAD06d3e24444381f44362a3B0eB343D337` per `gnosisguild/zodiac-modifier-roles` README. Verify the per-chain deployment. |
| Roles `Integrity` library | `0x6a6Af4b16458Bc39817e4019fB02BD3b26d41049` |
| Roles `Packer` library | `0x61C5B1bE435391fDd7BC6703F3740C0d11728a8C` |
| Roles `MultiSendUnwrapper` | `0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD` |
| Safe singleton / proxy factory | Resolve from the Safe deployments package for chain 8453 / 84532 |
| USDC on Base | Verify on Basescan before use |
| Aave v3 Pool on Base | Verify on Basescan before use |

### 5.2 Interfaces used

Roles Modifier v2:
```solidity
function execTransactionWithRole(address to, uint256 value, bytes calldata data,
        Enum.Operation operation, bytes32 roleKey, bool shouldRevert)
    external returns (bool success);

function execTransactionWithRoleReturnData(address to, uint256 value, bytes calldata data,
        Enum.Operation operation, bytes32 roleKey, bool shouldRevert)
    external returns (bool success, bytes memory returnData);

function assignRoles(address module, bytes32[] calldata roleKeys, bool[] calldata memberOf) external;
function setDefaultRole(address module, bytes32 roleKey) external;
function scopeTarget(bytes32 roleKey, address targetAddress) external;
function allowTarget(bytes32 roleKey, address targetAddress, ExecutionOptions options) external;
function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector,
        ConditionFlat[] calldata conditions, ExecutionOptions options) external;
```

Safe:
```solidity
function enableModule(address module) external;
function isModuleEnabled(address module) external view returns (bool);
function getOwners() external view returns (address[] memory);
function getThreshold() external view returns (uint256);
function nonce() external view returns (uint256);
```

Confirm the exact `ConditionFlat` struct layout and `ExecutionOptions` enum against the
pinned upstream source before writing the preset builder.

---

## 6. Components

### 6.1 `remit-core` (TypeScript)

Public surface:

```ts
buildRemit(input: RemitInput): Remit
remitDigest(m: Remit): Hex                       // EIP-712 digest
canonicalise(limits: Limits): string                 // sorted-key JSON
limitsHash(limits: Limits): Hex

checkEnvelope(intent: Intent, m: Remit, ledger: SpendLedger): EnvelopeResult   // G1
compileIntent(intent: Intent, m: Remit): WorkflowInvocation                    // typed inputs only

appendReceipt(chain: ReceiptChain, r: ReceiptInput): Receipt
verifyReceiptChain(chain: ReceiptChain): VerificationResult
```

`Intent` is a discriminated union. For the hackathon scope:

```ts
type Intent =
  | { kind: "erc20.approve"; token: Address; spender: Address; amount: bigint }
  | { kind: "aave.supply";   asset: Address; amount: bigint; onBehalfOf: Address }
  | { kind: "aave.withdraw"; asset: Address; amount: bigint; to: Address }
```

Adding an intent kind requires, in the same commit: a Zod schema, an envelope rule, a
compile rule, a Roles preset entry, and a failure-path test. The schema is the contract.

### 6.2 `remit-bridge` (Python)

Responsibilities: adapt Almanak strategy output into `Intent`, run G1 via the core package
(exposed through a thin CLI or a shared JSON schema — decided in PLAN.md day 1), call
KeeperHub, poll for completion, write receipts.

KeeperHub client surface (verify paths against `docs.keeperhub.com` and the OpenAPI before
implementing):

```
POST   /api/workflows/{id}/execute      -> { executionId }
GET    /api/workflows/{id}/executions   -> execution history, used to resolve txHash
GET    /api/chains                      -> supported networks
```

Because the execute response does not currently return `txHash` (upstream issue #1784),
`resolve_tx_hash(execution_id)` polls the executions endpoint with exponential backoff and
correlates strictly on `executionId`. If correlation is ambiguous, it raises
`ReceiptUnresolvable` rather than writing an uncertain hash.

The Almanak adapter is intentionally the thinnest possible seam. It reads the installed
Almanak SDK at a pinned version, implements whatever executor/gateway interface that
version exposes, and translates one strategy action into one `Intent`. It contains no
strategy logic. Strategy logic stays in Almanak, which is the entire point of integrating
rather than reimplementing.

### 6.3 `remit-console` (Next.js)

Four screens, no more:

1. **Remit** — the active Remit, its hashes, limits, headroom, expiry, signers.
2. **Review queue** — pending G3 approvals with the decoded action, fork-simulated balance
   delta, and the G2 result. Approve / decline.
3. **Ledger** — the receipt chain, each row linking to the KeeperHub execution and the
   block explorer. Chain integrity indicator.
4. **Kill switch** — builds and shows the `assignRoles` revocation transaction for a Safe
   owner to sign. Displays current membership status read live from chain.

### 6.4 `keeperhub-safe` — the bounty plugin

Self-contained KeeperHub plugin targeting issue #1241. Four nodes:

| Node | Type | Purpose |
|---|---|---|
| `safe.read_state` | read | owners, threshold, nonce, enabled modules, Roles membership |
| `safe.policy_check` | condition | G2 preflight, decoded Roles revert reason |
| `safe.exec_with_role` | action | `execTransactionWithRole` submission |
| `safe.propose` | action | post to Safe Transaction Service for the classic multisig path |

Delivered as a PR to `KeeperHub/keeperhub` with: unit tests, a fork test against Base
Sepolia, a docs page under `docs/`, Prometheus metrics wired to the existing collector,
and a filled-in plugin manifest generated by their `pnpm create-plugin` scaffold.

`safe.propose` is included because not every Safe will run Zodiac Roles. Teams that want
human-in-the-loop on every transaction get the proposal path; teams that want bounded
autonomy get the role path. Covering both is what makes the PR generally useful to
KeeperHub rather than specific to us.

---

## 7. Provenance receipt

One JSON object per execution attempt, appended to a hash chain.

```json
{
  "seq": 17,
  "prevHash": "0x…",
  "timestamp": "2026-09-17T09:41:12Z",
  "remitHash": "0x…",
  "strategyHash": "0x…",
  "strategyRef": "almanak-co/sdk@<pinned>, strategies/<name>@<commit>",
  "workflowHash": "0x…",
  "workflowId": "<KeeperHub workflow id>",
  "roleKey": "0x…",
  "intent": { "kind": "aave.supply", "asset": "0x…", "amount": "5000000", "onBehalfOf": "0x…" },
  "inputsHash": "0x…",
  "gates": {
    "g1": { "outcome": "pass" },
    "g2": { "outcome": "pass", "allowed": true },
    "g3": { "outcome": "approved", "by": "operator", "at": "2026-09-17T09:40:58Z" },
    "g4": { "outcome": "pass" }
  },
  "executionId": "<KeeperHub execution id>",
  "txHash": "0x…",
  "blockNumber": 0,
  "gasUsed": "0",
  "outcome": "executed",
  "selfHash": "0x…"
}
```

`selfHash = keccak256(canonicalJson(record without selfHash))`.
`prevHash` is the previous record's `selfHash`. Genesis uses `0x00…0`.

Rejected and declined attempts get receipts too, with `outcome` of `rejected_g1`,
`rejected_g2`, `declined_g3` or `reverted_g4` and no `txHash`. **A refusal is evidence.**
An audit trail that only records successes is not an audit trail.

`verifyReceiptChain` recomputes every `selfHash` and every link, and independently
re-derives `remitHash` and `limitsHash` from the stored documents. Anyone can run it
against the committed `receipts/` directory without access to our infrastructure.

---

## 8. Reliability and observability

What KeeperHub contributes and we must demonstrate, not merely claim:

- **Nonce management** — the agent signer's nonce is managed by KeeperHub. Demonstrated by
  firing three intents concurrently and showing all three land in order.
- **Gas escalation and retry with backoff** — demonstrated by submitting during a base-fee
  spike on a fork and showing the escalation in the run log.
- **Private routing** — enabled on the workflow; shown in configuration and run metadata.
- **Audit trail** — every run visible in KeeperHub's own execution history, cross-linked
  from our receipt by `executionId`.

Our own observability:

- Structured JSON logs keyed by `remitHash` and `executionId`.
- Gate outcome counters exported to the console: attempts, and the count rejected at each
  gate. A healthy system rejects at G1 far more often than it reverts at G4.
- Receipt chain integrity check on console load.

Non-happy-path behaviours that must work and be shown:

| Condition | Expected behaviour |
|---|---|
| Strategy proposes an out-of-envelope target | G1 rejects, receipt `rejected_g1`, no network call |
| Preset tightened after Remit signed | G2 rejects with decoded reason, no gas spent |
| Remit expired (`notAfter` passed) | G1 rejects, console shows expiry banner |
| Daily cap exhausted | G1 rejects, console shows zero headroom |
| RPC unavailable | Bridge retries with backoff, then writes `rejected_g2` with cause; never executes blind |
| KeeperHub execution stuck | `resolve_tx_hash` times out, raises `ReceiptUnresolvable`, execution flagged in console |
| Kill switch pulled mid-run | G2 and G4 both fail; receipts show the transition |

---

## 9. Setup and runbook

### 9.1 Prerequisites

Node 22, pnpm, Python 3.12, uv, Foundry (for `anvil` and `cast`), a Base RPC endpoint, a
KeeperHub account and API key.

### 9.2 One-time setup

```bash
cp .env.example .env          # fill in: BASE_RPC_URL, BASE_SEPOLIA_RPC_URL,
                              # KEEPERHUB_API_KEY, BASESCAN_API_KEY
pnpm install
uv sync --directory packages/remit-bridge

# 1. Deploy or select a Safe on Base Sepolia, 2-of-3 owners
pnpm --filter ops setup:safe --network base-sepolia

# 2. Deploy a Roles v2 instance and enable it as a module on the Safe
pnpm --filter ops setup:roles --network base-sepolia

# 3. Build the preset from the limits object, diff it against chain, apply it
pnpm --filter ops roles:build
pnpm --filter ops roles:diff  --network base-sepolia
pnpm --filter ops roles:apply --network base-sepolia

# 4. Register the KeeperHub workflow and record its id and hash
pnpm --filter ops workflow:register

# 5. Build and sign the Remit
remit issue --network base-sepolia          # build the Remit document
remit issue --sign                          # collect Safe-owner signatures
```

`roles:diff` is mandatory before `roles:apply`. It prints the exact set of permission
changes that will be made. Applying a preset without reading the diff is how treasuries
lose money.

### 9.3 Running

```bash
pnpm --filter remit-console dev      # http://localhost:3000
uv run --directory packages/remit-bridge \
  remit serve --strategy strategies/<name> --network base-sepolia
```

### 9.4 Mainnet

Base mainnet runs use a separate Safe, a separate Remit, and caps of 5 USDC per
transaction / 25 USDC per day. Execution requires:

```bash
pnpm --filter ops exec --network base --remit 0x<hash> --confirm
```

The command prints the decoded action, Safe, roleKey, notional and recipient, and waits
for a typed confirmation string before broadcasting.

### 9.5 Emergency

```bash
remit revoke --network base    # prints the assignRoles revocation tx for an owner to sign
```

Any single Safe owner can execute it. It does not depend on Remit, Almanak or KeeperHub
being reachable.

---

## 10. Security model

**Trusted:** the Safe owners; the audited Safe and Zodiac Roles v2 contracts; the Base L2.

**Semi-trusted:** KeeperHub (holds the agent signer via Turnkey/Para MPC; can execute
anything the role permits, which is bounded by the preset); the operator's console session.

**Untrusted:** the Almanak strategy code; the LLM; all market data; every input.

The security claim is precise: **compromise of every untrusted and semi-trusted component
simultaneously cannot move funds outside the preset.** The worst case is that the agent
repeatedly supplies and withdraws the Safe's own USDC to and from Aave, bounded by
`perTxCap`, until an owner pulls the kill switch. Griefing, not theft.

Residual risks, stated rather than hidden:

- A wrong preset grants real authority. Mitigated by `roles:diff` and by pinning
  recipient parameters to the Safe address. Not eliminated.
- A compromised console could approve a G3 item. Bounded by G4; the attacker still cannot
  exceed the preset.
- The Remit signature is advisory, not enforced on-chain. This is documented, not hidden.
  An on-chain Remit registry is the obvious next step and is deliberately out of scope
  for a five-day build (see CLAUDE.md §2.6).

---

## 11. Verification appendix

`docs/VERIFIED.md` is the single source of truth for every external fact. Required columns:

| Item | Value | Chain | Source URL | Verified on | Verified by |
|---|---|---|---|---|---|

Nothing enters code before it enters this table.
