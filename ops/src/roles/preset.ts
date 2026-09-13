/**
 * The minimal preset (DOCS.md §5).
 *
 * Three functions, on two targets, with the recipient parameters pinned to the Safe:
 *
 *   USDC.approve(spender = the Aave pool, amount = unconstrained here)
 *   Pool.supply(asset = USDC, amount = *, onBehalfOf = the Safe, referralCode = *)
 *   Pool.withdraw(asset = USDC, amount = *, to = the Safe)
 *
 * `onBehalfOf` and `to` use `EqualToAvatar`, which compares against the Safe without
 * naming its address. That single operator is the whole talk: the agent can move funds
 * *within* Aave but has no expressible call that moves them *out*. Exfiltration is not
 * disallowed, it is unrepresentable.
 *
 * `amount` is deliberately `Pass` at this layer. The per-transaction and daily caps live
 * in the Remit and are enforced at G1; expressing them here as well is P4's job via
 * `WithinAllowance`, and doing it twice with two sources of truth is worse than doing it
 * once. `ExecutionOptions.None` means no native value and no delegatecall, ever.
 */

import {
  AAVE_V3_POOL,
  AbiType,
  type ConditionFlat,
  ExecutionOptions,
  Operator,
  type SupportedChainId,
  USDC,
} from "@remit/core";
import {
  type Address,
  encodeAbiParameters,
  getAddress,
  type Hex,
  toFunctionSelector,
} from "viem";

export type ScopedFunction = {
  /** What a human calls it, for `roles:diff` output. */
  readonly label: string;
  readonly target: Address;
  readonly signature: string;
  readonly selector: Hex;
  readonly conditions: readonly ConditionFlat[];
  readonly options: number;
  /** One line per parameter, in order, for the diff. */
  readonly parameterNotes: readonly string[];
};

export type Preset = {
  readonly chainId: SupportedChainId;
  readonly roleKey: Hex;
  /** Distinct targets, in the order they must be cleared. */
  readonly targets: readonly Address[];
  readonly functions: readonly ScopedFunction[];
};

/** A 32-byte word holding a static value, as `EqualTo` wants it. */
function staticEqual(type: "address" | "uint256", value: Address | bigint): Hex {
  return encodeAbiParameters([{ type }], [value as never]);
}

/** The root of a function scope: "these children describe the arguments, in order". */
const CALLDATA_ROOT: ConditionFlat = {
  parent: 0,
  paramType: AbiType.Calldata,
  operator: Operator.Matches,
  compValue: "0x",
};

function unconstrained(): ConditionFlat {
  return {
    parent: 0,
    paramType: AbiType.Static,
    operator: Operator.Pass,
    compValue: "0x",
  };
}

function equalToAddress(value: Address): ConditionFlat {
  return {
    parent: 0,
    paramType: AbiType.Static,
    operator: Operator.EqualTo,
    compValue: staticEqual("address", getAddress(value)),
  };
}

function equalToSafe(): ConditionFlat {
  return {
    parent: 0,
    paramType: AbiType.Static,
    operator: Operator.EqualToAvatar,
    compValue: "0x",
  };
}

export function buildPreset(chainId: SupportedChainId, roleKey: Hex): Preset {
  const usdc = getAddress(USDC[chainId]);
  const pool = getAddress(AAVE_V3_POOL[chainId]);

  const approve: ScopedFunction = {
    label: "USDC.approve → Aave pool",
    target: usdc,
    signature: "approve(address,uint256)",
    selector: toFunctionSelector("approve(address,uint256)"),
    conditions: [CALLDATA_ROOT, equalToAddress(pool), unconstrained()],
    options: ExecutionOptions.None,
    parameterNotes: [
      `spender EqualTo ${pool} (the Aave v3 Pool — nothing else may be approved)`,
      "amount Pass (capped in the Remit, enforced at G1)",
    ],
  };

  const supply: ScopedFunction = {
    label: "Aave.supply(USDC) → the Safe",
    target: pool,
    signature: "supply(address,uint256,address,uint16)",
    selector: toFunctionSelector("supply(address,uint256,address,uint16)"),
    conditions: [
      CALLDATA_ROOT,
      equalToAddress(usdc),
      unconstrained(),
      equalToSafe(),
      unconstrained(),
    ],
    options: ExecutionOptions.None,
    parameterNotes: [
      `asset EqualTo ${usdc} (USDC only)`,
      "amount Pass (capped in the Remit, enforced at G1)",
      "onBehalfOf EqualToAvatar (the aTokens can only be credited to the Safe)",
      "referralCode Pass",
    ],
  };

  const withdraw: ScopedFunction = {
    label: "Aave.withdraw(USDC) → the Safe",
    target: pool,
    signature: "withdraw(address,uint256,address)",
    selector: toFunctionSelector("withdraw(address,uint256,address)"),
    conditions: [CALLDATA_ROOT, equalToAddress(usdc), unconstrained(), equalToSafe()],
    options: ExecutionOptions.None,
    parameterNotes: [
      `asset EqualTo ${usdc} (USDC only)`,
      "amount Pass (capped in the Remit, enforced at G1)",
      "to EqualToAvatar (withdrawn funds can only land back in the Safe)",
    ],
  };

  return {
    chainId,
    roleKey,
    targets: [usdc, pool],
    functions: [approve, supply, withdraw],
  };
}
