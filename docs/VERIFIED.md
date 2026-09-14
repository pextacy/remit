# VERIFIED

Every external address, ABI, selector and endpoint this project depends on, with the
source it came from and the check that confirmed it. Nothing here was recalled from
memory. A row is only allowed to exist once someone has run the check in the last column
(CLAUDE.md §2.2).

All checks below: **2026-09-13**, by the P0 verification pass.

The chain rows are re-runnable in one command, and should be re-run before P1 starts,
before the mainnet execution in P6, and on Friday morning:

```bash
pnpm --filter @remit/core verify:constants
```

---

## 1. Chains

| Item | Value | Source | Check |
|---|---|---|---|
| Base mainnet chain id | `8453` | `eth_chainId` at `https://mainnet.base.org` | returned `8453` |
| Base Sepolia chain id | `84532` | `eth_chainId` at `https://sepolia.base.org` | returned `84532` |

## 2. Zodiac Roles Modifier v2

| Item | Value | Source | Check |
|---|---|---|---|
| Roles mastercopy | `0x9646fDAD06d3e24444381f44362a3B0eB343D337` | gnosisguild/zodiac-modifier-roles, `packages/evm/mastercopies.json` → `Roles` → `2.1.0`, tag `zodiac-roles-sdk-v4.1.3`, commit `820e5bc975d1817bdd4bc4a95226f553f7b67b68` | `eth_getCode` returns 24401 bytes on **both** 8453 and 84532, byte-identical |
| Mastercopy version | **2.1.0** | same file; `packages/evm/package.json` is also `2.1.0` | — |
| Zodiac ModuleProxyFactory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` | gnosisguild/zodiac, `mastercopies/factory/1.2.0/ModuleProxyFactory/`, commit `89352c4f05d4b223b9c555ca963a787fd930da2d` | `eth_getCode` returns 2046 bytes on both chains, **byte-identical to that directory's `bytecode.json`**; 1.0.0 and 1.1.0 do not match |
| ModuleProxyFactory version | **1.2.0** | determined by the bytecode comparison above, not by a version string | — |
| `deployModule` | `(address,bytes,uint256)`, emits `ModuleProxyCreation(address,address)` | that ABI, committed at `packages/remit-core/src/chain/abi/module-proxy-factory.ts` | deployed a Roles proxy for a Safe on the fork |
| Roles `setUp` initializer | `setUp(bytes)` decoding `(address owner, address avatar, address target)` | `packages/evm/contracts/Roles.sol` lines 51-63, pinned tag | a proxy initialised with `(safe, safe, safe)` accepted `assignRoles` from the Safe and refused it from anyone else |
| `execTransactionWithRole` | `(address,uint256,bytes,uint8,bytes32,bool)` → `0xc6fe8747` | deployed ABI in `mastercopies.json`, `Roles` `2.1.0` | signature rebuilt from the ABI; selector from `cast sig` |
| `assignRoles` (kill switch) | `(address,bytes32[],bool[])` → `0x957ed2b3` | same | same |
| `scopeFunction` | `(bytes32,address,bytes4,(uint8,uint8,uint8,bytes)[],uint8)` → `0x7508dd98` | same | same |
| `scopeTarget` / `allowFunction` / `allowTarget` | `(bytes32,address)` / `(bytes32,address,bytes4,uint8)` / `(bytes32,address,uint8)` | same | same |
| `setAllowance` | `(bytes32,uint128,uint128,uint128,uint64,uint64)` | same | same |
| Custom errors (18) | `ConditionViolation(uint8,bytes32)`, `NoMembership()`, `NotAuthorized(address)`, `ModuleTransactionFailed()`, `CalldataOutOfBounds()`, `FunctionSignatureTooShort()`, `MalformedMultiEntrypoint()`, `HashAlreadyConsumed(bytes32)`, `AlreadyEnabledModule(address)`, `AlreadyDisabledModule(address)`, `InvalidModule(address)`, `InvalidPageSize()`, `ArraysDifferentLength()`, `SetupModulesAlreadyCalled()`, `InvalidInitialization()`, `NotInitializing()`, `OwnableInvalidOwner(address)`, `OwnableUnauthorizedAccount(address)` | deployed ABI, same entry | full ABI committed verbatim at `packages/remit-core/src/chain/abi/roles.ts` |
| `Status` enum (20 values, `Ok`…`EtherAllowanceExceeded`) | order as committed in `packages/remit-core/src/chain/roles-status.ts` | `packages/evm/contracts/PermissionChecker.sol` lines 728-764, same tag, package version 2.1.0 | copied in order; this is what G2 turns into a named reason |
| `ConditionFlat` layout | `(uint8 parent, uint8 paramType, uint8 operator, bytes compValue)` | `packages/evm/contracts/Types.sol`, same tag | matches the `scopeFunction` tuple in the deployed ABI |
| `ExecutionOptions` | `None=0, Send=1, DelegateCall=2, Both=3` | `Types.sol`, same tag | — |

Note for the preset (P1): in the 2.1.0 source the `ConditionFlat.paramType` field is
typed `AbiType`, not `ParameterType` as older Roles documentation calls it. Same wire
layout, different name. `Operator.EqualToAvatar` (15) pins a parameter to the Safe
without hardcoding its address — that is the operator the `onBehalfOf` / `to` conditions
want.

## 3. Safe

| Item | Value | Source | Check |
|---|---|---|---|
| Safe singleton v1.4.1 | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | safe-global/safe-deployments, via KeeperHub `lib/safe/contracts.ts` at commit `f8c8f18c754ccbca481774a1c3c0fdf71e282e96` | `VERSION()` → `"1.4.1"` on 8453 and 84532; 23579 bytes |
| Safe L2 singleton v1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | same | `VERSION()` → `"1.4.1"` on both; 24421 bytes |
| Safe proxy factory v1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | same | `eth_getCode` 3054 bytes on both |
| Safe compatibility fallback handler v1.4.1 | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | safe-global/safe-deployments `src/assets/v1.4.1/compatibility_fallback_handler.json`, commit `7b1fb6d615ab2d2999550ec9166554b180e813e5` — `canonical` on 8453 and 84532 | used in `setup`; a Safe deployed with it answered `VERSION()` and executed owner transactions on the fork |
| Safe v1.4.1 ABI (49 entries) | committed at `packages/remit-core/src/chain/abi/safe.ts` | same repo, `safe_l2.json`, same commit | exercised: `setup`, `getTransactionHash`, `approveHash`, `execTransaction`, `enableModule`, `isModuleEnabled`, `getOwners`, `getThreshold`, `nonce` |
| Safe proxy factory ABI | `packages/remit-core/src/chain/abi/safe-proxy-factory.ts` | same repo, `safe_proxy_factory.json`, same commit | `createProxyWithNonce` deployed a Safe and emitted `ProxyCreation` |
| `setup` initializer | `setup(address[],uint256,address,bytes,address,address,uint256,address)` | same ABI | 2-of-3 Safe deployed with `to = 0`, `data = 0x`, no payment |

Use the **L2 singleton** on Base and Base Sepolia.

## 4. Assets and venue

| Item | Value | Source | Check |
|---|---|---|---|
| USDC on Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | aave-dao/aave-address-book `src/ts/AaveV3Base.ts` at commit `02748a20592a019e834aee193b6c40c9bc7bd059` (`USDC.UNDERLYING`) | `symbol()` → `"USDC"`, `decimals()` → `6` |
| USDC on Base Sepolia | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | `src/ts/AaveV3BaseSepolia.ts`, same commit | `symbol()` → `"USDC"`, `decimals()` → `6` |
| Aave v3 Pool on Base | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `AaveV3Base.ts`, same commit | `ADDRESSES_PROVIDER()` → `0xe20f…d64D`, matches `POOL_ADDRESSES_PROVIDER` in the same file |
| Aave v3 Pool on Base Sepolia | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` | `AaveV3BaseSepolia.ts`, same commit | `ADDRESSES_PROVIDER()` → `0xE4C2…Ad00`, matches |
| `supply` | `(address,uint256,address,uint16)` → `0x617ba037` | aave-dao/aave-v3-origin `src/contracts/interfaces/IPool.sol` line 204, commit `8305565ae342f1773c42cd2e4593f175fe5968a0` | `cast sig` |
| `withdraw` | `(address,uint256,address) returns (uint256)` → `0x69328dec` | same file, line 243 | `cast sig` |
| `approve` | `(address,uint256)` → `0x095ea7b3` | EIP-20 | `cast sig` |

**The Base Sepolia USDC above is not Circle's testnet USDC.** It is the token Aave lists
in its own Base Sepolia market, which is the one `supply` accepts. Supplying the other one
reverts in a way that looks like a preset failure and is not.

## 5. KeeperHub API

Verified against the upstream repository at a pinned commit, not against the live service
— see docs/OPEN_QUESTIONS.md OQ-1. Source: `KeeperHub/keeperhub`, default branch
`staging`, commit `f8c8f18c754ccbca481774a1c3c0fdf71e282e96`.

| Item | Finding |
|---|---|
| Execute routes | `POST /api/execute/transfer`, `/api/execute/swap`, `/api/execute/contract-call`, `/api/execute/check-and-execute`, `/api/execute/node`, and a catch-all `/api/execute/[...slug]` |
| Execute response | `{ executionId, status, transactionHash?, transactionLink? }`, HTTP `202 ACCEPTED`. The hash **is** included when it is known at response time (`app/api/execute/contract-call/route.ts`) |
| Status route | `GET /api/execute/{executionId}/status` — note the segment order |
| Status response | `{ executionId, status, type, transactionHash, transactionLink, sponsored, receipts, result, error, gasUsedWei, gasPriceWei, estimatedCostUsd, retryCount, network, createdAt, completedAt }` |
| Terminal statuses | `completed`, `failed`. The route returns a poll-interval hint of 2s while in flight, 0 when terminal |
| Auth | API key; the status route additionally requires the `mcp:read` scope, and is rate-limited per API key |
| Safe support | `plugins/safe/` exists upstream, and Safe + Zodiac Roles execution is implemented at `app/api/user/safe/[safeId]/role/*`, `lib/safe/roles-orchestrator.ts`, `lib/safe/zodiac-roles.ts`, with a fork test at `tests/e2e/vitest/safe-roles-orchestrator-fork.test.ts` |
| Documented Roles path | `docs/wallet-management/safe.md`: workflow writes route through `rolesModifier.execTransactionWithRole`, Roles v2 on Ethereum, Base, Arbitrum, Optimism, Polygon and Sepolia |
| Issue #1241 | **Closed 2026-08-11 as completed.** A maintainer comment: "this one actually is already implemented" |
| Issue #1784 | **Closed 2026-08-03 as completed.** The execute response now carries `transactionHash`/`transactionLink` when known |
| Contribution policy | `ISSUES.md`: anything that changes behaviour needs an issue **accepted by a maintainer** before the pull request. Reference it as `Closes #N` |
| Plugin layout | `plugins/{name}/{index.ts,icon.tsx,credentials.ts,test.ts,steps/*.ts}`; step files carry `"use step"`, export only the step function plus `_integrationType` and types, share logic via `*-core.ts`, use `fetch` rather than Node-only SDKs; `pnpm create-plugin` scaffolds, `pnpm discover-plugins` registers |

## 6. Almanak SDK

Installed at the pinned version and read from the installed source, per CLAUDE.md §8.

| Item | Finding |
|---|---|
| Package / version | `almanak` **2.28.0** on PyPI (`almanak-sdk` does not exist — 404) |
| Strategy → platform seam | gRPC. `almanak.framework.gateway_client.GatewayClient` exposes `.execution` → `ExecutionServiceStub` |
| `ExecutionService` | `CompileIntent(CompileIntentRequest) → CompilationResult`, `Execute(ExecuteRequest) → ExecutionResult`, `GetTransactionStatus(TxStatusRequest) → TxStatus` |
| `CompileIntentRequest` | `intent_type: string`, `intent_data: bytes`, `chain: string`, `wallet_address: string`, `price_map: PriceMapEntry[]` |
| `ExecuteRequest` | `action_bundle: bytes`, `dry_run: bool`, `simulation_enabled: bool`, `deployment_id: string`, `intent_id: string`, `chain: string`, `wallet_address: string`, `max_gas_price_gwei: int32` |
| `ExecutionResult` | `success`, `tx_hashes: string[]`, `total_gas_used`, `receipts: bytes`, `error`, `error_code`, `execution_id`, `submission_provenance`, `execution_plan_hash`, `submission_transactions[]` |
| Server base class | `almanak.gateway.proto.gateway_pb2_grpc.ExecutionServiceServicer` — subclassable, so Remit can **serve** this interface without forking the SDK |
| Pointing a strategy at us | `ALMANAK_GATEWAY_HOST` > `GATEWAY_HOST` > `localhost`; `ALMANAK_GATEWAY_PORT` > `GATEWAY_PORT` > `50051`; also `_TIMEOUT` and `_AUTH_TOKEN` (`GatewayClientConfig.from_env`) |
| In-process alternative | `almanak.framework.execution.interfaces` has `Signer`, `Submitter`, `Simulator` ABCs. `Submitter.submit(txs: list[SignedTransaction])` takes **already-signed** transactions, so it is the wrong seam for us: KeeperHub signs with its own key and cannot re-sign someone else's raw transaction |
| Intent vocabulary | `almanak.core.intent_types.IntentType` — `SUPPLY`, `WITHDRAW`, `SWAP`, `BORROW`, `REPAY`, and ~25 more |
| Base-chain demo strategy | `almanak/demo_strategies/metamorpho_base_yield/` ships in the package |

**AL-2 go/no-go: GO.** The seam is the gRPC `ExecutionService`. Remit implements
`ExecutionServiceServicer`, an unmodified strategy is pointed at it with
`ALMANAK_GATEWAY_HOST`/`PORT`, and `Execute` routes through G1 → KeeperHub instead of
broadcasting. No fork, no patched SDK, and `action_bundle` arrives as a compiled bundle
rather than as model-authored calldata.

Caveat for P5 to settle: `ExecutionResult` already carries `submission_provenance` and
`execution_plan_hash`. Read what Almanak puts in those before repeating the claim in
PRD.md §7 that nothing today links a transaction back to a strategy version.

---

## 7. Roles behaviour, observed

Read off a local Anvil fork of Base Sepolia on 2026-09-14, by
`pnpm --filter ops p1 --network anvil`. Forked real state, real contracts, real reverts
(CLAUDE.md §2.1) — not a testnet transaction, which still needs funded keys (OQ-6).

| Behaviour | Observed |
|---|---|
| A `supply` inside the preset | executes; the Safe's USDC balance falls and the aTokens land on the Safe |
| A `withdraw` with `to` = the Safe | executes |
| A `withdraw` with `to` = anyone else | `ConditionViolation` → **ParameterNotAllowed**, free |
| `USDC.transfer` — a function never scoped | `ConditionViolation` → **FunctionNotAllowed**, `info` carries the selector `0xa9059cbb` |
| A scoped call sent to an unscoped target | `ConditionViolation` → **TargetAddressNotAllowed**, free |
| The same refused call, forced on chain | reverts, ~67k gas, nothing moves |
| A stranger calling `execTransactionWithRole` | `NotAuthorized(address)` — the `moduleOnly` guard, before any role check |
| The agent after `assignRoles(..., false)` | `NoMembership()` |
| Membership, read back | Roles 2.1.0 exposes **no getter** for the members mapping. It is observed by simulating a call and reading the error: `NotAuthorized` or `NoMembership` means no, anything else means yes. `isModuleEnabled` is not a substitute — revoking a role does not disable the module |

Two traps worth writing down, both cost time on 2026-09-14:

- **`owners.map(getAddress)` is a bug.** `Array.prototype.map` passes the index as the
  second argument, and viem's second parameter is a chainId that switches the function to
  EIP-1191 checksumming. The result fails viem's own address validation. Always
  `map((x) => getAddress(x))`.
- **Gas estimation swallows the revert you are trying to demonstrate.** A call that is
  meant to fail has to be sent with an explicit gas limit, or the client throws during
  estimation and nothing ever reaches the chain.

---

## 8. The Remit, reproduced

Issued on 2026-09-14 against the fork deployment, by `pnpm --filter ops remit:issue`, and
re-derived three independent ways by `pnpm --filter ops remit:verify-digest`.

| Check | Method | Result |
|---|---|---|
| `limitsHash` | canonical JSON → keccak256, recomputed from the file on disk | matches the value inside the Remit |
| Canonical JSON is order-independent | same document with its keys reversed, re-hashed | identical hash |
| `remitHash` | viem `hashTypedData` | — |
| `remitHash` | foundry `cast`, built from the EIP-712 definition with no shared code | identical |
| `remitHash` | the value written into `ops/remits/<network>.json` when it was issued | identical |

The type string that is hashed, which anyone can check with `cast keccak`:

```
Remit(bytes32 strategyHash,bytes32 workflowHash,address safe,address rolesModifier,bytes32 roleKey,bytes32 limitsHash,uint256 chainId,uint64 notBefore,uint64 notAfter,uint256 nonce)
→ typeHash 0x948389bed2538200ce0f7cb0adabe422e2dd55bf8b1f9c39b9adb108ea26b16e
```

`strategyHash` on that run was keccak256 of a real file — the `metamorpho_base_yield`
strategy shipped inside `almanak==2.28.0` — not a placeholder. `workflowHash` is keccak256
of the canonicalised `ops/workflows/exec-with-role.workflow.json`, which is our own
declaration of what must run and is reconciled with the registered workflow in P3 (OQ-7).

## 9. G1, observed

`pnpm --filter ops g1 --network anvil` runs the gate over 19 intents. Every error code in
the union is reached, and each refusal names the field, what the Remit allows and what the
intent asked for.

| Intent | Outcome |
|---|---|
| supply 5 USDC to the Safe | passes, flagged for G3 review (above 1 USD) |
| supply 0.50 USDC | passes, no review |
| withdraw 2 USDC to the Safe | passes; the daily cap is untouched — withdrawals come home |
| an intent carrying a `data` field | `INTENT_MALFORMED` — the schema is `.strict()`, so an unknown key is a refusal rather than a field that is quietly ignored |
| an asset named by address | `INTENT_MALFORMED` — assets are symbols, so a strategy cannot name a token nobody verified |
| an amount as a float | `INTENT_MALFORMED` |
| withdraw or supply to an attacker | `OUT_OF_REMIT_RECIPIENT` |
| approve an attacker as spender | `OUT_OF_REMIT_SPENDER` — checked against the venue list, not the recipient list |
| a kind, venue or function the Remit omits | `OUT_OF_REMIT_KIND` / `_TARGET` / `_SELECTOR` |
| 6 USDC against a 5 USDC cap | `REMIT_CAP_EXCEEDED_PER_TX` |
| 5 USDC with 25 already supplied today | `REMIT_CAP_EXCEEDED_DAILY` |
| the seventh action in an hour | `REMIT_RATE_LIMIT_EXCEEDED` |
| before `notBefore` / after `notAfter` | `REMIT_NOT_YET_VALID` / `REMIT_EXPIRED` |
| a testnet Remit used on mainnet | `REMIT_CHAIN_MISMATCH` |
| limits widened after issue, hash left alone | `REMIT_LIMITS_MISMATCH` |

Observed end to end with `pnpm --filter ops propose`, which runs G1 then G2 then the
chain: three approve/supply cycles executed, and the fourth was refused at G1 by the
hourly rate limit, across separate processes — the ledger is on disk, so the cap survives
a restart (G1-5).

G2 also refuses for reasons that are nothing to do with policy: with the ERC-20 allowance
exhausted, the preflight returned `ModuleTransactionFailed()` before any gas was spent.

---

## 10. The receipt chain, observed

Written and checked on 2026-09-14 over a fork of Base Sepolia. Six receipts, produced by
two different programs, verified by a third.

| Outcome | Written by | Gates recorded |
|---|---|---|
| `rejected_g1` | `ops propose` (TypeScript) | G1 refused — `action` is **null**, because the intent never reached the compiler |
| `executed` ×3 | `ops propose` | G1 pass → G2 pass → G4 pass, with the transaction hash and an explorer link |
| `rejected_g2` | `ops propose` | G1 pass → G2 refused with `ModuleTransactionFailed()`, no gas spent |
| `rejected_g1` | `remit run` (Python) | appended to the same chain, and it still verifies |

`uv run remit verify` re-derives all six from the bytes on disk, plus `remitHash` and
`limitsHash` from the stored documents. The Python bridge does not implement any of that:
it calls the TypeScript core over a process boundary, so there is one canonical JSON, one
keccak, one gate. Two implementations of a hash rule become two hash rules the first time
someone fixes a bug in one of them.

Tamper detection, demonstrated three ways:

| Tamper | Caught as |
|---|---|
| Edit an amount from 5 to 500 USD, leave `selfHash` | `selfHash does not match the receipt's own bytes` |
| Delete a record from the middle of the chain | `sequence is out of order`, and `prevHash does not link` on every record after it |
| Edit the amount **and** re-seal with a valid `selfHash` | `prevHash does not link to the previous receipt` — the next record still points at the hash the edited one used to have |

The third is the one that matters: a forger who has read the code and can compute a
correct hash still has to rewrite every record after the one they touched, and the head of
the chain is what a receipt cites.

## 11. KeeperHub client — written, not yet observed

`packages/remit-bridge/src/remit_bridge/keeperhub.py` is written against the routes,
field names, status vocabularies and auth header read from the KeeperHub repository at
commit `f8c8f18c…` (§5 above). **It has not been run against the live service** — that
needs an account (OQ-1) — so every model in it is a reading of the source rather than an
observation, and it is marked as such in the module docstring.

Two things the source settled that would otherwise have been guesses:

- The two execution routes have **different status vocabularies and different hash
  fields**. The workflow route returns `transactionHashes` (plural) with terminal statuses
  `success | error | system_error | skipped | cancelled`; the direct route returns a single
  `transactionHash` with `completed | failed`. Code that assumed one shape would silently
  fail against the other.
- `functionArgs` on `/api/execute/contract-call` is a **JSON string**, not an array.

The plural `transactionHashes` is exactly the ambiguity KH-4 is about: an execution that
reports more than one hash cannot be correlated to a single transaction by execution id
alone, so `resolve_tx_hash` raises `ReceiptUnresolvable` with the candidates rather than
picking one. A receipt is then written with `outcome: "unresolved"` and no hash. A gap in
the chain is honest; a plausible wrong hash is what an auditor finds instead of us.

---

## Re-verification log

| Date | What | Result |
|---|---|---|
| 2026-09-13 | Full P0 pass: 24 chain assertions across 8453 and 84532 | all pass |
| 2026-09-14 | P3: six receipts written by two programs over a fork, chain verified from Python through the TypeScript core, three tamper modes caught | chain intact, all tampers detected |
| 2026-09-14 | P2: Remit issued and re-derived by viem, foundry and the committed file; G1 run over 19 intents covering every error code | all agree, 19/19 |
| 2026-09-14 | P1 on a fork of Base Sepolia: Safe + Roles deployed, preset applied, 3 executions, 3 free refusals, 1 on-chain revert, kill switch pulled and restored | 15/15 steps, four consecutive clean runs |
