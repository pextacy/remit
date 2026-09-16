/**
 * Narrow a role without tearing it down.
 *
 *   pnpm --filter ops roles:revoke --network anvil --function "withdraw(address,uint256,address)"
 *   pnpm --filter ops roles:revoke --network anvil --target 0x…
 *
 * The kill switch removes the agent from the role entirely. This is the smaller
 * instrument: stop it doing one thing — say, withdrawing — while it carries on doing the
 * rest. An operator who only has the big lever pulls the big lever, and an agent that is
 * switched off is not an agent that is safely bounded.
 *
 * Both are owner transactions through the Safe, and both show up in the next `roles:diff`
 * as a difference from the preset. That is the intended behaviour: the preset is the
 * declaration, the chain is the authority, and the diff is how you notice they parted.
 */

import { rolesAbi } from "@remit/core";
import { encodeFunctionData, getAddress, parseAbiItem, toFunctionSelector } from "viem";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import { fail, logEvent, say } from "../lib/log.js";
import { execSafeTx, safeCall } from "../lib/safe.js";

const args = parseArgs();
const network = networkFrom(args);
const cast = await castFor(network);
const deployment = requireDeployment(network.name);
const safe = requireField(deployment, "safe");
const rolesModifier = requireField(deployment, "rolesModifier");
const roleKey = requireField(deployment, "roleKey");

const signature = option(args, "function");
const targetArg = option(args, "target");

if (signature === undefined && targetArg === undefined) {
  fail("give --function 'name(types)' or --target 0x… — nothing was revoked");
}

if (signature !== undefined) {
  const target = getAddress(
    option(args, "on") ??
      fail("--function needs --on 0x… — a selector is only meaningful on a contract"),
  );
  // Parsed, not merely hashed. `toFunctionSelector` will happily take `foo(bar)` — it is
  // a keccak of a string — and hand back a selector that matches no function on the
  // target. `revokeFunction` then succeeds, the operator is told the thing is revoked,
  // and the function they meant to stop is still callable. `parseAbiItem` is what
  // actually knows `uint7` is not a type.
  try {
    parseAbiItem(`function ${signature}`);
  } catch {
    fail(
      `--function "${signature}" is not a function signature. Nothing was revoked: a ` +
        "selector taken from a string that is not a signature revokes nothing and says " +
        "it did.",
    );
  }
  const selector = toFunctionSelector(signature);

  say(`revoking  ${signature} (${selector}) on ${target}`);
  await execSafeTx(
    network,
    safe,
    cast.signingOwners,
    safeCall(
      rolesModifier,
      encodeFunctionData({
        abi: rolesAbi,
        functionName: "revokeFunction",
        args: [roleKey, target, selector],
      }),
    ),
    "roles.revokeFunction",
  );
  logEvent("roles.revoked", { kind: "function", signature, selector, target });
}

if (targetArg !== undefined) {
  const target = getAddress(targetArg);
  say(`revoking  every function on ${target}`);
  await execSafeTx(
    network,
    safe,
    cast.signingOwners,
    safeCall(
      rolesModifier,
      encodeFunctionData({
        abi: rolesAbi,
        functionName: "revokeTarget",
        args: [roleKey, target],
      }),
    ),
    "roles.revokeTarget",
  );
  logEvent("roles.revoked", { kind: "target", target });
}

say("");
say("run `roles:diff` to see how the chain now differs from the preset");
