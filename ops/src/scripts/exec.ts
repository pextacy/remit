/**
 * PLAN.md 1.4 and 1.5 — move value out of the Safe through the role, and show that a call
 * outside the preset cannot be made to work.
 *
 *   pnpm --filter ops run exec --network anvil --action approve  --amount 50
 *   pnpm --filter ops run exec --network anvil --action supply   --amount 50
 *   pnpm --filter ops run exec --network anvil --action withdraw --amount 10
 *   pnpm --filter ops run exec --network anvil --action withdraw --amount 10 --violate
 *   pnpm --filter ops run exec --network anvil --action withdraw --amount 10 --violate --force
 *   pnpm --filter ops run exec --network anvil --action transfer --amount 10
 *   pnpm --filter ops run exec --network anvil --action supply --amount 10 --target 0x…
 *
 * Every run preflights first, free. `--force` sends a call the preflight already refused,
 * with an explicit gas limit, so the on-chain refusal is recorded too. `--violate` points
 * the action at an address that is not the Safe; there is no way to express that under
 * this preset, which is the point.
 *
 * Exit codes: 0 executed, 2 refused at preflight, 1 something is wrong.
 */

import { erc20Abi, USDC, USDC_DECIMALS } from "@remit/core";
import { type Address, formatUnits, getAddress, parseUnits } from "viem";
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
import { explorerTx, publicClientFor } from "../lib/clients.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import {
  executeThroughRole,
  preflight,
  type RoleAction,
  refusalIsOpaque,
} from "../lib/exec-role.js";
import { fail, logEvent, say } from "../lib/log.js";

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

const client = publicClientFor(network);
const chainId = network.chainId;
const usdc = getAddress(USDC[chainId]);
const amount = parseUnits(option(args, "amount") ?? "1", USDC_DECIMALS);
const violate = args.flags.has("violate");

/** Where value is asked to land. The preset pins this to the Safe. */
const recipient: Address = violate
  ? cast.attacker
  : getAddress(option(args, "to") ?? safe);

function build(): RoleAction {
  switch (option(args, "action") ?? "supply") {
    case "approve":
      return approveAction(
        chainId,
        violate ? cast.attacker : AAVE_POOL_FOR(chainId),
        amount,
      );
    case "supply":
      return supplyAction(chainId, recipient, amount);
    case "withdraw":
      return withdrawAction(chainId, recipient, amount);
    case "transfer":
      return transferAction(chainId, cast.attacker, amount);
    default:
      return fail("--action must be approve, supply, withdraw or transfer");
  }
}

const targetOverride = option(args, "target");
const action =
  targetOverride === undefined ? build() : redirect(build(), getAddress(targetOverride));

say(`action    ${action.label}`);
say(`through   ${rolesModifier} execTransactionWithRole`);
say(`as        ${cast.agent.address} (role ${roleKey})`);
if (violate || targetOverride !== undefined) {
  say("mode      OUT OF PRESET — this call is supposed to be refused");
}
say("");

const check = await preflight(
  network,
  rolesModifier,
  roleKey,
  cast.agent.address,
  action,
);

if (check.ok) {
  say("preflight PASS — the Roles Modifier would allow this call");
} else {
  say(`preflight REFUSED — ${check.reason}`);
  if (refusalIsOpaque(check)) {
    fail(
      "preflight returned an undecodable revert — the ABI no longer matches the chain",
    );
  }
  if (!args.flags.has("force")) {
    say("");
    say(
      "No gas was spent. Re-run with --force to send it anyway and let the chain refuse.",
    );
    process.exit(2);
  }
}

const result = await executeThroughRole(
  network,
  rolesModifier,
  roleKey,
  cast.agent,
  action,
  {
    expectRevert: !check.ok,
  },
);

const balance = (await client.readContract({
  address: usdc,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [safe],
})) as bigint;

say("");
say(`tx        ${result.hash}`);
say(`status    ${result.status}`);
say(`explorer  ${explorerTx(chainId, result.hash)}`);
say(`safe USDC ${formatUnits(balance, USDC_DECIMALS)}`);

logEvent(check.ok ? "p1.4.done" : "p1.5.done", {
  action: action.label,
  txHash: result.hash,
  status: result.status,
  gasUsed: result.gasUsed.toString(),
  safeUsdc: balance.toString(),
});

if (!check.ok && result.status === "success") {
  fail("an out-of-preset call succeeded on chain — the preset is wrong");
}
