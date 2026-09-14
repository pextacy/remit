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

## 12. Reading the preset back off the chain

Roles 2.1.0 has **no getter** for a role's targets, functions or conditions. The state
exists — `scopeConfig` is a mapping inside a struct — but nothing public reads it, and
`eth_getStorageAt` against a packed mapping is the kind of cleverness that is wrong six
months later without saying so.

The contract does emit everything it does, and `ScopeFunction` carries the entire
condition tree in the log:

```
ScopeTarget(bytes32 roleKey, address targetAddress)
ScopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector,
              (uint8,uint8,uint8,bytes)[] conditions, uint8 options)
AllowTarget / AllowFunction / RevokeTarget / RevokeFunction / AssignRoles
```

So `roles:diff` replays those events for the role and reconstructs it exactly, from the
contract's own account of itself. That is what makes it a diff rather than a description
of what is about to be sent.

Observed on 2026-09-14, on a fork of Base Sepolia:

| Situation | What `roles:diff` said |
|---|---|
| Roles deployed, no preset applied | two targets `+ … [WIDENS AUTHORITY]`, "not cleared on chain" |
| Immediately after `roles:apply` | "no difference — the chain already says exactly what the preset says" |
| After `roles:revoke --function withdraw(address,uint256,address)` | `+ withdraw(…) [WIDENS AUTHORITY] — not scoped on chain` |
| After re-applying the preset | no difference again |

With `withdraw` revoked on chain, a withdraw intent passed **G1** and was refused at
**G2** with `FunctionNotAllowed`, the selector `0x69328dec` in `info`. That is the
preset-tightened-after-the-Remit case (NH-2), reached without editing anything by hand.

`roles:apply` now runs the diff first and refuses to do anything when there is nothing to
do. On mainnet it additionally refuses to apply a widening without `--yes`.

## 13. The kill switch

`pnpm --filter ops kill` is one owner transaction calling
`assignRoles(agent, [roleKey], [false])`. Observed:

| | member | preflight |
|---|---|---|
| before | `true` | PASS — the Roles Modifier would allow it |
| after | `false` | REFUSED — `NoMembership()` |
| after `--restore` | `true` | PASS |

Four receipts, `outcome: "observed"`, in the same chain as everything else — the
transition is in the ledger rather than in a screenshot (NH-4). A supply proposed after
the switch was pulled passed G1 and was refused at G2 with `NoMembership()`, and that
refusal has a receipt too.

The probe uses `approve`, not `supply`, because `supply` on an unfunded Safe fails inside
Aave — a true answer to a different question. The probe distinguishes the two: a
`ConditionViolation`, `NoMembership` or `NotAuthorized` means the role refused; a
`ModuleTransactionFailed` means the role allowed the call and the call itself failed.
Conflating them would make an unfunded Safe look like a revoked agent, and an operator
checking the switch would be told what they wanted to hear.

---

## 14. The Almanak seam, served

Read from the SDK at the pinned version and then exercised with the SDK's own client on
2026-09-14, against a fork of Base Sepolia.

What the runner actually sends
(`almanak/framework/runner/_inner_runner_helpers.py`, lines 180-290):

```python
execution.CompileIntent(CompileIntentRequest(
    intent_type=intent_type,                       # "SUPPLY"
    intent_data=json.dumps(intent_params).encode(),# the serialised intent, as JSON
    chain=chain, wallet_address=wallet, price_map=price_map))

execution.Execute(ExecuteRequest(
    action_bundle=compile_resp.action_bundle,      # whatever the server returned
    dry_run=…, simulation_enabled=…, deployment_id=…, chain=…, wallet_address=…))
```

`action_bundle` is opaque to Almanak — the server defines it, and here the server is
Remit. That is the whole reason this integration needs no fork of the SDK: Remit answers
`ExecutionServiceServicer`, and a strategy is pointed at it with `ALMANAK_GATEWAY_HOST`
and `ALMANAK_GATEWAY_PORT`.

Observed, with `remit serve` on one side and `almanak.framework.gateway_client.GatewayClient`
on the other:

| Sent | Answer |
|---|---|
| The strategy's own `SUPPLY 5 USDC` | `CompileIntent` success → `Execute(dry_run)` → G1 pass, G2 pass, receipt `observed` |
| `protocol: "compound_v3"` | `PROTOCOL_UNSUPPORTED` — the preset scopes Aave v3 only |
| `amount: "500"` | `REMIT_CAP_EXCEEDED_PER_TX` — G1, against a 5 USD cap |
| `amount: "all"` | `AMOUNT_CHAINED` — the value comes from a previous step the adapter does not have, and it will not guess |
| `token: "WETH"` | `ASSET_UNSUPPORTED` |
| A `SUPPLY` with no ERC-20 allowance in place | G1 pass, then G2 `ModuleTransactionFailed()` — the role allowed it, the call itself would fail |

Two details from the SDK worth carrying:

- The SDK **warns that symbol-based token references are deprecated** and will be rejected
  in Almanak 3.0. The adapter therefore accepts either `"USDC"` or the token *address* —
  but an address only when it equals the one in `docs/VERIFIED.md` §4 for that chain. A
  strategy still cannot name a token nobody verified.
- `amount` can legitimately be the string `"all"`, meaning "whatever the previous step
  produced". The adapter refuses it rather than substituting a balance, because the
  number it would substitute is not the number the strategy meant.

## 15. Two drift refusals at startup

`remit serve` checks the world before it accepts an intent, and refuses to run on either
kind of drift. Both observed on 2026-09-14:

| Drift | What it did |
|---|---|
| `withdraw` revoked on chain after the Remit was issued | `REMIT_PRESET_DRIFT: 1 difference(s) …` — refused to start (RM-4) |
| the strategy file edited after the Remit was issued | `REMIT_STRATEGY_DRIFT` — the file hashes to `0xd97a79…`, the Remit binds `0x8431b1…`, refused to start |

The second is the one that keeps `strategyHash` honest. A receipt claims that *this*
source produced *that* transaction; a bridge that runs an edited strategy under an old
Remit would be writing receipts that name source which did not produce them, and
provenance is the one claim that cannot survive being approximately true.

Recovery is the same for both, and it is never "widen something": reissue the Remit
against what is actually there, or put back what the Remit binds.

---

## 16. The mainnet path, rehearsed on Base

Run on 2026-09-14 against a fork of **Base mainnet** — chain 8453, the real Roles
mastercopy, Circle's real USDC, the real Aave v3 pool. Not a testnet analogue: the
addresses, the preset and the caps are the ones the real run will use, and the only thing
that differs is whose money it is.

| Step | Result |
|---|---|
| Safe deployed through the canonical v1.4.1 factory | 2-of-3, 306,183 gas |
| Roles v2 proxy deployed, enabled, agent assigned | 191,158 + 107,518 + 126,786 gas |
| Preset applied with mainnet addresses | USDC `0x833589fC…`, Aave pool `0xA238Dd80…`, 742,144 gas over five owner transactions |
| `roles:diff` after applying | no difference |
| Safe funded with 30 USDC | by impersonating a contract holding real USDC and transferring — forked real state moved by its real holder |
| Remit issued | caps 5 / 25 USD, `chainId` 8453 |
| `mainnet:preflight` | 15 of 16 checks pass; the one that does not is `KEEPERHUB_API_KEY` (OQ-1) |
| `approve` through the role | executed, 114,110 gas |
| `supply` through the role | executed, 285,436 gas, value left the Safe into Aave |
| Receipt chain | verifies |

Total for the whole sequence: **1,873,335 gas**, about **0.0000112 ETH** at the 0.006 gwei
price observed on Base that day. Gas is not the constraint; the 30 USDC is.

Two things the rehearsal settled that a testnet run could not:

- Circle's USDC on Base has an `owner` but **minting requires a configured minter with an
  allowance**, so the funding path that works on Base Sepolia's Aave test token reverts
  here. `fund` now tries the minter and falls back to a real holder.
- The mainnet preset is not the testnet preset with different numbers: it names different
  contracts, and `buildPreset(8453, …)` producing the right ones is the thing that had
  not been exercised until now.

The runbook, the costs and the preconditions are in docs/MAINNET.md.

---

## 17. The bounty contribution, verified against upstream

The premise in `PRD.md` §5.10 is stale (OQ-3), so P7 narrowed to the gap upstream
documents in its own source. `lib/execute/simulate.ts`:

> **Known limitation:** `from` is resolved via `getOrganizationWalletAddress` (the org's
> EOA / smart account address). Orgs that route writes through a Safe will produce a
> simulation that reflects the EOA sending the call, not the Safe. This still catches most
> config bugs (bad ABI, bad args, allowance mismatches) but does not perfectly mirror
> Safe-routed `msg.sender` semantics.

For a `safe-role` organization the Roles modifier is not in the simulated path at all: a
call the role forbids simulates clean, is broadcast, and reverts on chain — decoded
correctly by `classifyRevert`, after the gas is gone. The contribution is one action that
asks the question first.

Every upstream symbol it depends on was checked to exist at commit
`f8c8f18c754ccbca481774a1c3c0fdf71e282e96`:

| Symbol | Where |
|---|---|
| `buildExecTransactionWithRoleCalldata` | `lib/safe/zodiac-roles.ts:224` |
| `resolveSignerMode`, `SignerMode` (`safe-role` carries `rolesModifierAddress`, `roleKey`, `delegateAddress`) | `lib/safe/signer-resolver.ts:197`, `:60` |
| `getRpcProvider` | `lib/rpc/provider-factory.ts:118` |
| `classifyRevert`, `formatContractError`, `RevertKind` (`role-condition-violation` carries `status`, `statusCode`, `paramOrKey`) | `lib/web3/decode-revert-error.ts:574`, `:180`, `:456` |
| `runPluginStep`, `StepInput`, `StepContext` | `lib/workflow/executor/step-handler.ts:286`, `:79`, `:30` |
| `getChainIdFromNetwork` | `lib/rpc/network-utils.ts:15` |

Checked by copying the files into a clone of the repository and running their own tooling:

| Check | Result |
|---|---|
| `npx tsgo --noEmit` (their canonical type-check, whole repo) | exit 0 |
| `pnpm discover-plugins` | registers `safe/policy-check` → `policyCheckStep` in `lib/step-registry.ts` |
| Their existing Safe unit tests, with the action registered | 61 passed |
| Step-file rule 1 — exports only the step function, `_integrationType` and types | holds |
| Their "no raw network egress in plugins" rule | holds — no `fetch`, `axios` or `http.request` |

Three details their tooling settled that reading alone would have got wrong:

- **`StepContext` has no `userId`.** `getRpcProvider({ chainId })` is the call; passing a
  user id from the step context does not compile.
- **`getChainIdFromNetwork` is synchronous** and throws on an unknown network.
- **The repository targets ES2017**, so `0n` does not compile. Upstream writes `BigInt(0)`,
  and so does this.

**Not done: tests.** BP-4 asks for unit tests and a Base Sepolia fork test, and this is not
mergeable without them — see the phase status. The issue and pull-request drafts are
written and unposted; upstream requires an accepted issue before a pull request
(`ISSUES.md`), and posting either is the repository owner's to do.

---

## 18. The failure surface

`pnpm --filter ops nh --network anvil` runs every non-happy-path requirement and writes a
receipt for each, into the same chain as every real run. Observed on 2026-09-14:

| Requirement | Evidence |
|---|---|
| NH-1 out-of-envelope target | `OUT_OF_REMIT_RECIPIENT`, and **0 RPC requests** made reaching that answer — counted around the gate, not asserted in prose |
| NH-2 preset tightened after signing | `withdraw` revoked on chain; G1 passed, G2 refused with `FunctionNotAllowed`, no gas |
| NH-3 forced out-of-preset transaction | reverted on chain, 66,979 gas, receipt carries the hash |
| NH-4 kill switch mid-session | `NoMembership()` at G2, then reverted at G4, membership restored afterwards |
| NH-5 daily cap exhausted | `REMIT_CAP_EXCEEDED_DAILY`, headroom **0** of 25 USD |
| NH-6 RPC unavailable | refused after ~1s of retries against a port with nothing listening; nothing sent |
| NH-7 three concurrent intents | see below — the interesting one |

**On "bypassing" a gate.** CLAUDE.md §2.5 forbids a bypass flag and there is none. The
gates are independent functions, and the scenario runner asks each one directly: the
injection case puts the same poisoned intent to G1, then to G2, then to the chain. No code
path in the product skips a gate, and nothing in the runner is reachable from `propose`,
`exec:mainnet` or `remit serve`.

### The injection scenario

One input, crafted to send the Safe's USDC to an attacker. Ran twice in a row, unattended:

```
G1  REFUSED  OUT_OF_REMIT_RECIPIENT — 0 network calls, no gas
G2  REFUSED  ParameterNotAllowed    — one eth_call, no gas
G4  REVERTED 0x988c6c22…            — 66,979 gas, nothing moved
             the attacker holds 0 USDC
```

Three receipts, three independent refusals, one story.

### NH-7 is a finding, not a green tick

Three intents fired at once on the ops-direct path: **1 of 3 landed, 2 were refused on
nonce**. Three transactions from one EOA with nothing managing the nonce collide, and the
client refuses rather than replacing one silently — a safe failure, and the wrong outcome
for an execution layer.

Serialised, the same three land in order (nonces 2491, 2492, 2493). Serialising is the
work a caller has to do when nothing else manages the nonce, and it is exactly the work
KeeperHub takes over. **This evidences the problem, not the fix**: evidencing KeeperHub's
nonce management needs an account (OQ-1), and the receipt for it says `ops-direct` so no
reader can mistake one for the other.

### Verified from a clean clone

```
git clone . /tmp/clean-clone && cd /tmp/clean-clone && pnpm install
uv run --directory packages/remit-bridge remit verify --network <chain>
```

Run against a fresh clone with no access to anything of ours: **18 receipts checked with
the Remit and limits documents, chain intact**. Editing one field of one receipt and
leaving its hash produced `selfHash does not match the receipt's own bytes` from the
clone's own copy of the verifier.

The receipts and the Remit used for that run are the rehearsal's — they are gitignored, so
a clone gets the verifier but not yet a chain to check. The committed chain arrives with
the first public-testnet run (OQ-6).

---

## 19. The console, observed

Run against the fork on 2026-09-14, `REMIT_NETWORK=anvil pnpm --filter remit-console dev`.
All five screens return 200 and render live data.

| Screen | What it showed |
|---|---|
| Overview | gate counters read from the receipts themselves — G1 10 attempts / 4 refused, G2 5/5, G4 6/3 — plus spend, headroom and chain integrity |
| Ledger | 12 receipts with their gates, transaction links and `prev` hashes; the integrity line is recomputed from the bytes on every load |
| Remit | the five hashes, the limits, headroom, and expiry as a countdown rather than a timestamp |
| Kill switch | `agent authority: active`; after `ops kill`, the same page reloaded to `revoked` |
| Review | the pending item, with the decoded action in named parameters |

### G3, end to end

```
pnpm --filter ops propose --network anvil --kind approve --amount 5 --review
  G1 PASS
  G2 PASS
  G3 WAITING  b5f821a6-… — a human has to approve this in the console
      → console shows it; decision written
  G3 APPROVED operator
  G4 PASS     0x20e55851…
```

And the refusal, which is the half that matters (G3-3):

```
  G3 DECLINED treasury-op: not today
  receipt 0013-declined_g3.json → outcome: declined_g3
     G1 pass · G2 pass · G3 declined · G3_DECLINED · treasury-op: not today
```

A decline is a terminal receipt in the same chain as everything else. A timeout is treated
the same way: a review that times out into an approval is not a review.

Three properties of the console worth stating, because they are design decisions rather
than omissions:

- **It shows the decoded action, never raw calldata.** An operator asked to approve a hex
  blob is being asked to rubber-stamp, and a gate that produces rubber-stamping is worse
  than no gate because it launders the decision.
- **It cannot pull the kill switch.** Revoking is a Safe owner transaction; the console has
  no owner keys and should not want them. It gives the calldata and the address, so the
  switch works when our stack is the thing that has failed.
- **An unreachable chain reads as "unknown", not "revoked".** Telling someone the switch is
  pulled when nobody checked is the worst answer that page could give.

---

## 20. The submission checklist, as a command

`pnpm --filter ops submit:check` decides the half of PLAN.md §11 that a machine can, and
names the rest as a person's. Run on 2026-09-14: **12 checked, 3 blocking, 6 waiting on a
person**.

The three blocking items are the same three that have been blocking since P0, stated the
same way: no committed receipt chain (the rehearsal chains are gitignored, because a
rehearsal chain is not evidence), no Base mainnet transaction, and — at the time of that
run — an uncommitted working tree.

Two checks worth having beyond the obvious:

- **The whole git history is scanned for key material**, not the working tree. A key
  removed in a later commit is still a key anybody can `git log -p` out of the repository,
  and "we deleted it" is a disclosure rather than a remediation. 26,325 lines scanned,
  clean.
- **Every address the code can reach is matched against a row in this file.** The rule is
  that nothing unverified reaches a chain (CLAUDE.md §2.2), and the way that rots is a
  constant added in a hurry without its row. Eight checked.

The quality gates are run rather than assumed: `type-check`, `biome check` and `ruff`, all
three, on every invocation.

### The final full run

2026-09-14, cold, against a fork of Base Sepolia, in the order PLAN.md §8 asks for:

| | |
|---|---|
| `verify:constants` | all constants agree with chain |
| `p1` | 15 steps |
| `remit:verify-digest` | three independent paths agree |
| `g1` | 19 intents, 19 expected outcomes |
| `roles:diff` | no difference |
| `nh` | 8 requirements held |
| `remit verify` | 12 receipts, chain intact |
| `remit serve` + the strategy | preset agrees, strategy hash matches, G1 passed |

One thing that run fixed: the public Base RPC rate-limited `verify:constants` into a
false failure. It now retries six times with a quadratic backoff and uses `BASE_RPC_URL`
when one is configured — the script that runs immediately before a mainnet execution must
never let "could not read" look like "the constant changed".

---

## 21. Completing what was left

The P1-priority requirements that had never been implemented, and the two verbs the
public CLI was missing. All observed on 2026-09-14 against the fork.

### RM-5 — the Remit, signed and verified

`pnpm --filter ops remit:sign` signs the EIP-712 digest with every owner the machine can
sign for — `eth_signTypedData_v4` through the node on a fork, so no key exists in the
process. `remit serve` verifies them against the Safe's **current** owners before it
accepts anything.

| | |
|---|---|
| three owners sign | `ok  3 of 2 required owner signatures` |
| the bridge starts | `signed  3 owner signature(s), verified against the Safe's current owners` |
| one hex digit flipped in each | `REMIT_SIGNATURES_INVALID: 0 valid owner signature(s), 2 required; 2 signature(s) are not from a current Safe owner` → refused to start |

Verifying against the chain's owners rather than a list in the file is the point: owners
change, and a signature from a removed owner no longer carries their authority.

### G3-5 — a changed strategy version forces review

G1 now takes the `strategyHash` this agent last actually executed under, read from the
receipt chain. A Remit reissued against an edited strategy held a **0.50 USD** action —
well under the 1 USD threshold — with the reason *"the strategy has changed version since
this agent last executed"*. A new version's first transaction is the one worth looking at,
and it is exactly the one a notional threshold waves through.

### G3-4 — the simulated balance delta

The review queue now carries what the Safe's USDC would do, and the console shows it:

```
safe USDC -5    160 → 155 USDC in the Safe
                Simulated against current state — the check on whether the call
                does what its name says.
```

`eth_simulateV1` with three calls in one simulated block: read the Safe's balance, run the
call as the agent, read it again. **Not** viem's `traceAssetChanges`, which reports changes
for the *sending* account — here the agent EOA, whose balance does not move. The account
whose balance matters is the Safe. A node that cannot simulate gets "unavailable" rather
than a guessed number.

### The four verbs

`remit issue` and `remit revoke` now exist, so the public CLI is the four verbs CLAUDE.md
§1 names. Both are deliberately thin wrappers over the ops scripts that do the chain work —
duplicating that work in Python would be a second implementation of the thing this project
is about not having.

### One bug this pass found, and it was hiding others

`core.py` preferred the built `dist/cli.js` whenever it existed. A stale build therefore
ran silently: a signature check that had been written, wired and unit-checked reported
green against a `dist` compiled before it existed. It now prefers the build **only when it
is newer than the sources**, and the console's scripts rebuild the core before running.

A stale gate is the worst kind of bug in a system like this — everything keeps answering,
the answers look right, and they are the answers of code nobody is reading any more.

---

## Re-verification log

| Date | What | Result |
|---|---|---|
| 2026-09-13 | Full P0 pass: 24 chain assertions across 8453 and 84532 | all pass |
| 2026-09-14 | Completion pass: RM-5 signing and startup verification, G3-4 balance delta, G3-5 strategy-change review, the `issue` and `revoke` verbs, BP-4 tests | all observed; a stale-build trap found and closed |
| 2026-09-14 | P10: submit:check over PLAN §11 — 12 checked, 3 blocking, 6 human; whole git history scanned clean; full path re-run cold | ready except the three known blockers |
| 2026-09-14 | P9: five console screens rendering live fork data; G3 approved and declined end to end, with a `declined_g3` receipt | all 200, gate wired |
| 2026-09-14 | P8: all seven NH requirements demonstrated with receipts; the injection scenario twice in a row; the chain verified from a clean clone and a tamper caught there | 8/8 held |
| 2026-09-14 | P7: the policy-check action copied into a clone of `KeeperHub/keeperhub` — their type-check, their plugin discovery and their Safe unit tests all pass with it | mergeable except for tests |
| 2026-09-14 | P6: the whole mainnet sequence rehearsed on a fork of Base mainnet — deploy, preset, fund, issue, preflight, two executions through the role | works at chain 8453; the public transaction still needs a funded key and KeeperHub |
| 2026-09-14 | P5: the strategy decided and its intent crossed Almanak's own client into `remit serve`; four rogue intents refused by name; both startup drift checks refused | seam works, receipts carry the strategy hash |
| 2026-09-14 | P4: `roles:diff` reconstructed the role from 11 events and matched the preset exactly; drift introduced and detected; kill switch pulled and restored with four receipts | diff exact, switch verified by preflight |
| 2026-09-14 | P3: six receipts written by two programs over a fork, chain verified from Python through the TypeScript core, three tamper modes caught | chain intact, all tampers detected |
| 2026-09-14 | P2: Remit issued and re-derived by viem, foundry and the committed file; G1 run over 19 intents covering every error code | all agree, 19/19 |
| 2026-09-14 | P1 on a fork of Base Sepolia: Safe + Roles deployed, preset applied, 3 executions, 3 free refusals, 1 on-chain revert, kill switch pulled and restored | 15/15 steps, four consecutive clean runs |
