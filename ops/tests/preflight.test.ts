/**
 * G2 has three answers, not two.
 *
 * "The Roles Modifier refused" and "the node did not reply" are different facts, and only
 * one of them is a reading of the preset. They used to arrive as the same value: a
 * `fetch failed` carries no revert data, so `decodeRevert` answered `undecodable` and the
 * gate reported a refusal — `undecodable revert 0x` — for a question it had never managed
 * to ask.
 *
 * Three things followed from that, and all three were reachable by an RPC blip: an
 * operator was sent to check an ABI, `kill` read an unreachable chain as an agent that
 * could still act, and the pipeline exited on the "opaque revert" branch *before* writing
 * its receipt — so the one G2 outcome most worth a record left none.
 *
 * A gate that refuses because nobody answered is the mirror of a gate that passes because
 * nobody checked, and this codebase already refuses to have the second one.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { getAddress } from "viem";
import {
  preflight,
  preflightWasUnanswered,
  refusalIsOpaque,
} from "../src/lib/exec-role.js";
import { resolveNetwork } from "../src/lib/networks.js";
import { SAFE } from "./fixtures.js";

/** Nothing listens here. Port 9 is `discard`, and it is not open on a CI runner. */
const NOWHERE = "http://127.0.0.1:9";

const ROLES = getAddress("0x1A500342644ce5BAA9485afaf84bB78d5E9d34De");
const AGENT = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const ROLE_KEY = `0x${"11".repeat(32)}` as const;

async function ask(rpcUrl: string) {
  process.env.ANVIL_RPC_URL = rpcUrl;
  return preflight(resolveNetwork("anvil"), ROLES, ROLE_KEY, AGENT, {
    label: "probe",
    target: SAFE,
    data: "0x095ea7b3",
  });
}

describe("a chain that does not answer is not a chain that refused", () => {
  test("an unreachable node is reported as unanswered", async () => {
    const result = await ask(NOWHERE);

    assert.equal(result.ok, false, "a node that is not there cannot allow anything");
    assert.equal(preflightWasUnanswered(result), true);
  });

  test("it is not reported as an ABI that has drifted", async () => {
    const result = await ask(NOWHERE);

    // `refusalIsOpaque` is what makes the pipeline stop and tell an operator the
    // deployed modifier is not the version whose ABI this build pins. Telling them that
    // when their RPC is down costs them the hour they spend believing it.
    assert.equal(refusalIsOpaque(result), false);
  });

  test("the reason says nothing was asked, rather than naming a revert", async () => {
    const result = await ask(NOWHERE);

    assert.equal(result.ok, false);
    assert.match(result.reason, /did not answer/);
    assert.doesNotMatch(
      result.reason,
      /revert/,
      "an unanswered preflight must not describe itself as a revert",
    );
  });
});
