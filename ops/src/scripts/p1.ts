/**
 * The whole of P1 in one command, from an empty chain to a decoded refusal.
 *
 *   anvil --fork-url https://sepolia.base.org --port 8546
 *   ANVIL_RPC_URL=http://127.0.0.1:8546 pnpm --filter ops p1 --network anvil
 *
 * Why this exists: a phase that only ever ran as six commands in someone's shell is not
 * evidence, it is an anecdote. This reruns the whole path against forked Base Sepolia
 * state and prints a table a reviewer can check — deployment, preset, a supply that
 * worked, and three refusals with three different named reasons.
 *
 * It is not a test suite and does not pretend to be one. It asserts the things that would
 * make the phase a lie if they were false, and exits non-zero if any of them are.
 */

import {
  AAVE_V3_POOL_ADDRESSES_PROVIDER,
  buildPreset,
  describePreset,
  encodePreset,
  erc20Abi,
  USDC,
  USDC_DECIMALS,
} from "@remit/core";
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
} from "viem";
import {
  AAVE_POOL_FOR,
  approveAction,
  redirect,
  supplyAction,
  transferAction,
  withdrawAction,
} from "../lib/actions.js";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { explorerTx, publicClientFor, send, waitForNode } from "../lib/clients.js";
import { writeDeployment } from "../lib/deployment.js";
import { executeThroughRole, preflight, type RoleAction } from "../lib/exec-role.js";
import { fail, logEvent, say } from "../lib/log.js";
import {
  assignRole,
  deployRolesModifier,
  enableModule,
  isRoleMember,
} from "../lib/roles.js";
import { deploySafe, execSafeTx, safeCall } from "../lib/safe.js";

const TOKEN_MINT_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const args = parseArgs();
const network = networkFrom(args);
if (!network.canImpersonate) {
  fail(
    "p1 runs against a fork — on a real network run the six scripts, with your own keys",
  );
}

await waitForNode(network);

const cast = await castFor(network);
const client = publicClientFor(network);
const chainId = network.chainId;
const usdc = getAddress(USDC[chainId]);
const salt = BigInt(keccak256(toHex(option(args, "salt") ?? `remit-p1-${Date.now()}`)));
const roleKey = stringToHex("remit-agent", { size: 32 }) as Hex;

const rows: { step: string; outcome: string; detail: string }[] = [];
function record(step: string, outcome: string, detail: string): void {
  rows.push({ step, outcome, detail });
  logEvent("p1.step", { step, outcome, detail });
}

// ---- 1.1 a 2-of-3 Safe -----------------------------------------------------
const { safe } = await deploySafe(network, cast.deployer, {
  owners: cast.ownerAddresses,
  threshold: 2,
  saltNonce: salt,
});
record("1.1 safe", "deployed", safe);

// ---- 1.2 Roles, enabled, with the agent in the role ------------------------
const { rolesModifier, block } = await deployRolesModifier(
  network,
  cast.deployer,
  safe,
  salt,
);
await enableModule(network, safe, cast.signingOwners, rolesModifier);
await assignRole(
  network,
  safe,
  cast.signingOwners,
  rolesModifier,
  cast.agent.address,
  roleKey,
  true,
);

const member = await isRoleMember(
  network,
  rolesModifier,
  safe,
  cast.agent.address,
  roleKey,
);
if (!member) fail("the agent signer is not a member of the role");
record("1.2 roles", "enabled", `${rolesModifier} member=${cast.agent.address}`);

// A stranger must not be. If this ever returns true, nothing below means anything.
if (await isRoleMember(network, rolesModifier, safe, cast.attacker, roleKey)) {
  fail("a stranger is a member of the role");
}
record("1.2 roles", "stranger refused", cast.attacker);

// ---- 1.3 the preset --------------------------------------------------------
const preset = buildPreset(chainId, roleKey);
say("");
say(describePreset(preset, safe));
say("");

for (const call of encodePreset(preset)) {
  await execSafeTx(
    network,
    safe,
    cast.signingOwners,
    safeCall(rolesModifier, call.data),
    call.label,
  );
}
record(
  "1.3 preset",
  "applied",
  `${preset.targets.length} targets, ${preset.functions.length} functions`,
);

// ---- funding: the token's own minter, on forked state ----------------------
const tokenOwner = (await client.readContract({
  address: usdc,
  abi: TOKEN_MINT_ABI,
  functionName: "owner",
})) as `0x${string}`;
const { impersonate } = await import("../lib/clients.js");
const minter = await impersonate(network, tokenOwner);
const funded = parseUnits("100", USDC_DECIMALS);
await send(
  network,
  minter,
  {
    to: usdc,
    data: encodeFunctionData({
      abi: TOKEN_MINT_ABI,
      functionName: "mint",
      args: [safe, funded],
    }),
  },
  "usdc.mint",
);
record("setup", "funded", `${formatUnits(funded, USDC_DECIMALS)} USDC into the safe`);

// ---- 1.4 a real transaction out of the Safe, through the role --------------
async function mustPass(action: RoleAction, step: string): Promise<void> {
  const check = await preflight(
    network,
    rolesModifier,
    roleKey,
    cast.agent.address,
    action,
  );
  if (!check.ok) fail(`${step} was refused at preflight: ${check.reason}`);
  const result = await executeThroughRole(
    network,
    rolesModifier,
    roleKey,
    cast.agent,
    action,
  );
  if (result.status !== "success") fail(`${step} reverted: ${result.hash}`);
  record(step, "executed", `${result.hash}  ${explorerTx(chainId, result.hash)}`);
}

const amount = parseUnits("50", USDC_DECIMALS);
await mustPass(approveAction(chainId, AAVE_POOL_FOR(chainId), amount), "1.4 approve");
await mustPass(supplyAction(chainId, safe, amount), "1.4 supply");
await mustPass(
  withdrawAction(chainId, safe, parseUnits("10", USDC_DECIMALS)),
  "1.4 withdraw",
);

const balanceAfter = (await client.readContract({
  address: usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [safe],
})) as bigint;
if (balanceAfter >= funded)
  fail("no value left the safe — the supply did not take effect");
record(
  "1.4 result",
  "value moved",
  `safe holds ${formatUnits(balanceAfter, USDC_DECIMALS)} USDC`,
);

// ---- 1.5 three refusals, three named reasons -------------------------------
async function mustRefuse(
  action: RoleAction,
  step: string,
  expected: string,
): Promise<void> {
  const check = await preflight(
    network,
    rolesModifier,
    roleKey,
    cast.agent.address,
    action,
  );
  if (check.ok)
    fail(`${step} was allowed — the preset does not constrain what it claims to`);
  if (check.decoded.kind === "undecodable" || check.decoded.kind === "empty") {
    fail(`${step} returned an unnamed revert — an undecoded 0x… is a failed requirement`);
  }
  const named =
    check.decoded.kind === "roles_condition_violation"
      ? check.decoded.statusName
      : check.decoded.kind === "roles_error"
        ? check.decoded.name
        : check.decoded.kind;
  if (named !== expected) fail(`${step} refused with ${named}, expected ${expected}`);
  record(step, "refused free", `${named} — no gas spent`);
}

const attackerWithdraw = withdrawAction(
  chainId,
  cast.attacker,
  parseUnits("10", USDC_DECIMALS),
);
await mustRefuse(attackerWithdraw, "1.5 recipient", "ParameterNotAllowed");
await mustRefuse(
  transferAction(chainId, cast.attacker, parseUnits("10", USDC_DECIMALS)),
  "1.5 function",
  "FunctionNotAllowed",
);
await mustRefuse(
  redirect(
    supplyAction(chainId, safe, parseUnits("10", USDC_DECIMALS)),
    getAddress(AAVE_V3_POOL_ADDRESSES_PROVIDER[chainId]),
  ),
  "1.5 target",
  "TargetAddressNotAllowed",
);

// The same call, sent anyway. A refusal that only ever happened in a simulation is a
// claim; one that cost gas on chain is evidence.
const forced = await executeThroughRole(
  network,
  rolesModifier,
  roleKey,
  cast.agent,
  attackerWithdraw,
  { expectRevert: true },
);
if (forced.status !== "reverted") fail("an out-of-preset call succeeded on chain");
record("1.5 forced", "reverted on chain", `${forced.hash}  gas ${forced.gasUsed}`);

// ---- the kill switch, while we are here ------------------------------------
await assignRole(
  network,
  safe,
  cast.signingOwners,
  rolesModifier,
  cast.agent.address,
  roleKey,
  false,
);
if (await isRoleMember(network, rolesModifier, safe, cast.agent.address, roleKey)) {
  fail("membership survived revocation");
}
const afterKill = await preflight(
  network,
  rolesModifier,
  roleKey,
  cast.agent.address,
  supplyAction(chainId, safe, parseUnits("1", USDC_DECIMALS)),
);
if (afterKill.ok) fail("the agent can still act after the kill switch");
record("kill switch", "authority gone", afterKill.reason);

await assignRole(
  network,
  safe,
  cast.signingOwners,
  rolesModifier,
  cast.agent.address,
  roleKey,
  true,
);
record("kill switch", "restored", "membership reinstated for the next run");

writeDeployment({
  network: network.name,
  chainId,
  safe,
  owners: cast.ownerAddresses,
  threshold: 2,
  rolesModifier,
  rolesDeployedBlock: Number(block),
  roleKey,
  agentSigner: cast.agent.address,
  presetAppliedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

say("");
say("P1 — chain path");
say("".padEnd(96, "─"));
for (const row of rows) {
  say(`${row.step.padEnd(16)} ${row.outcome.padEnd(18)} ${row.detail}`);
}
say("".padEnd(96, "─"));
say("value moved out of a Safe through Zodiac Roles, and every call outside the preset");
say("was refused with a name — three of them for free, one of them on chain.");
logEvent("p1.done", { safe, rolesModifier, roleKey, steps: rows.length });
