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
| Zodiac ModuleProxyFactory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` | same repo, `lib/safe/zodiac-contracts.ts` in KeeperHub cross-references the same address | `eth_getCode` returns 2046 bytes on both chains |
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

## Re-verification log

| Date | What | Result |
|---|---|---|
| 2026-09-13 | Full P0 pass: 24 chain assertions across 8453 and 84532 | all pass |
