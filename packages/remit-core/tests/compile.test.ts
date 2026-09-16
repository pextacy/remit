/**
 * Intent → calldata, and the preset that decides whether those bytes are permitted.
 *
 * The project's whole claim is that a strategy cannot express a call the operator did not
 * sanction. That claim lives in two files — the compiler, which is the only place bytes
 * are built, and the preset, which is what the chain enforces — so both are pinned here
 * against fixed vectors rather than against themselves.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { decodeFunctionData, toFunctionSelector } from "viem";
import { aavePoolAbi } from "../src/chain/abi/aave-pool.js";
import { erc20Abi } from "../src/chain/abi/erc20.js";
import { AbiType, ExecutionOptions, Operator } from "../src/chain/roles-enums.js";
import { compileIntent, resolveAsset } from "../src/compile/action.js";
import { buildPreset } from "../src/roles/preset.js";
import { intentSchema } from "../src/schema/intent.js";
import { ATTACKER, CHAIN, POOL, ROLE_KEY, SAFE, USDC_ADDRESS, usdc } from "./fixtures.js";

const parse = (value: unknown) => intentSchema.parse(value);

describe("the compiler builds only what the ABIs allow", () => {
  test("approve names the spender and the amount, and nothing else", () => {
    const action = compileIntent(
      CHAIN,
      parse({
        kind: "approve",
        asset: "USDC",
        amount: usdc("5"),
        spender: POOL,
      }),
    );

    assert.equal(action.target, USDC_ADDRESS);
    assert.equal(action.signature, "approve(address,uint256)");
    assert.equal(action.selector, toFunctionSelector("approve(address,uint256)"));

    const decoded = decodeFunctionData({ abi: erc20Abi, data: action.calldata });
    assert.equal(decoded.functionName, "approve");
    assert.deepEqual(decoded.args, [POOL, 5_000_000n]);
  });

  test("supply pins referralCode to zero — a free field in calldata we control", () => {
    const action = compileIntent(
      CHAIN,
      parse({
        kind: "supply",
        asset: "USDC",
        amount: usdc("5"),
        onBehalfOf: SAFE,
      }),
    );

    assert.equal(action.target, POOL);
    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: action.calldata });
    assert.equal(decoded.functionName, "supply");
    assert.deepEqual(decoded.args, [USDC_ADDRESS, 5_000_000n, SAFE, 0]);
  });

  test("withdraw carries the asset from the verified table, not from the intent", () => {
    const action = compileIntent(
      CHAIN,
      parse({
        kind: "withdraw",
        asset: "USDC",
        amount: usdc("2"),
        to: SAFE,
      }),
    );

    const decoded = decodeFunctionData({ abi: aavePoolAbi, data: action.calldata });
    assert.equal(decoded.functionName, "withdraw");
    assert.deepEqual(decoded.args, [USDC_ADDRESS, 2_000_000n, SAFE]);
  });

  test("the asset is a symbol resolved per chain, so an unchecked token cannot be named", () => {
    assert.equal(resolveAsset(CHAIN, "USDC"), USDC_ADDRESS);
    // There is no intent field that carries an address for the asset at all: the schema
    // would refuse it before the compiler ever saw it.
    assert.throws(() =>
      parse({ kind: "supply", asset: USDC_ADDRESS, amount: "1", onBehalfOf: SAFE }),
    );
  });

  test("the counterparty is the field G1 checks, per kind", () => {
    const approve = compileIntent(
      CHAIN,
      parse({
        kind: "approve",
        asset: "USDC",
        amount: "1",
        spender: POOL,
      }),
    );
    const supply = compileIntent(
      CHAIN,
      parse({
        kind: "supply",
        asset: "USDC",
        amount: "1",
        onBehalfOf: SAFE,
      }),
    );
    const withdraw = compileIntent(
      CHAIN,
      parse({
        kind: "withdraw",
        asset: "USDC",
        amount: "1",
        to: ATTACKER,
      }),
    );

    assert.equal(approve.counterparty, POOL);
    assert.equal(supply.counterparty, SAFE);
    assert.equal(withdraw.counterparty, ATTACKER);
  });

  test("the description a reviewer reads names the parameters, not the bytes", () => {
    const action = compileIntent(
      CHAIN,
      parse({
        kind: "supply",
        asset: "USDC",
        amount: usdc("5"),
        onBehalfOf: SAFE,
      }),
    );
    assert.match(action.description, /supply .* USDC to Aave, credited to 0x/);
    assert.doesNotMatch(action.description, /0x[0-9a-f]{100}/);
  });

  test("the same intent always compiles to the same bytes", () => {
    const intent = parse({
      kind: "supply",
      asset: "USDC",
      amount: usdc("5"),
      onBehalfOf: SAFE,
    });
    assert.equal(
      compileIntent(CHAIN, intent).calldata,
      compileIntent(CHAIN, intent).calldata,
    );
  });
});

describe("the preset is the product", () => {
  const preset = buildPreset(CHAIN, ROLE_KEY);

  test("it scopes two targets and three functions, and no more", () => {
    assert.deepEqual([...preset.targets], [USDC_ADDRESS, POOL]);
    assert.equal(preset.functions.length, 3);
  });

  test("every function forbids native value and delegatecall", () => {
    for (const fn of preset.functions) {
      assert.equal(fn.options, ExecutionOptions.None, fn.label);
    }
  });

  test("supply pins onBehalfOf to the Safe without naming its address", () => {
    // EqualToAvatar is the line the whole talk rests on: the agent can move funds within
    // Aave and has no expressible call that moves them out.
    const supply = preset.functions.find((fn) => fn.signature.startsWith("supply"));
    assert.ok(supply);
    const onBehalfOf = supply.conditions[3];
    assert.equal(onBehalfOf?.operator, Operator.EqualToAvatar);
    assert.equal(onBehalfOf?.compValue, "0x");
  });

  test("withdraw pins `to` the same way", () => {
    const withdraw = preset.functions.find((fn) => fn.signature.startsWith("withdraw"));
    assert.ok(withdraw);
    assert.equal(withdraw.conditions[3]?.operator, Operator.EqualToAvatar);
  });

  test("approve pins the spender to the pool by value", () => {
    const approve = preset.functions.find((fn) => fn.signature.startsWith("approve"));
    assert.ok(approve);
    assert.equal(approve.conditions[1]?.operator, Operator.EqualTo);
    assert.match(
      String(approve.conditions[1]?.compValue).toLowerCase(),
      new RegExp(POOL.slice(2).toLowerCase()),
    );
  });

  test("the asset parameter is pinned to USDC on both Aave functions", () => {
    for (const fn of preset.functions.filter((f) => f.target === POOL)) {
      assert.equal(fn.conditions[1]?.operator, Operator.EqualTo, fn.label);
      assert.match(
        String(fn.conditions[1]?.compValue).toLowerCase(),
        new RegExp(USDC_ADDRESS.slice(2).toLowerCase()),
      );
    }
  });

  test("each scope is rooted at the whole calldata, matching arguments in order", () => {
    for (const fn of preset.functions) {
      assert.equal(fn.conditions[0]?.paramType, AbiType.Calldata, fn.label);
      assert.equal(fn.conditions[0]?.operator, Operator.Matches, fn.label);
    }
  });

  test("the compiler's selectors are exactly the ones the preset scopes", () => {
    // If these ever drift, G1 would admit a call the chain refuses — or worse, the other
    // way round.
    const scoped = new Set(preset.functions.map((fn) => fn.selector));
    for (const intent of [
      { kind: "approve", asset: "USDC", amount: "1", spender: POOL },
      { kind: "supply", asset: "USDC", amount: "1", onBehalfOf: SAFE },
      { kind: "withdraw", asset: "USDC", amount: "1", to: SAFE },
    ]) {
      const action = compileIntent(CHAIN, parse(intent));
      assert.ok(scoped.has(action.selector), action.signature);
    }
  });

  test("a preset for another role is the same shape with a different key", () => {
    const other = buildPreset(CHAIN, `0x${"ab".repeat(32)}`);
    assert.notEqual(other.roleKey, preset.roleKey);
    assert.deepEqual(
      other.functions.map((fn) => fn.selector),
      preset.functions.map((fn) => fn.selector),
    );
  });
});
