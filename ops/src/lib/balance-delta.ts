/**
 * G3-4 — what the Safe would hold afterwards, simulated.
 *
 * A reviewer asked to approve "supply 5 USDC" is being asked to trust that the call does
 * what its name says. The balance delta is the check on that: the same call, simulated
 * against current state, reporting what actually moves.
 *
 * `eth_simulateV1` with asset tracing, which anvil and most modern nodes support. When a
 * node does not, the answer is "unavailable" rather than a guess — a review screen that
 * invents a delta is worse than one that admits it does not have it, because the reviewer
 * cannot tell the difference.
 */

import { erc20Abi, USDC, USDC_DECIMALS } from "@remit/core";
import {
  type Address,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
} from "viem";
import { publicClientFor } from "./clients.js";
import { logEvent } from "./log.js";
import type { Network } from "./networks.js";

export type BalanceDelta =
  | { readonly available: true; readonly usdc: string; readonly note: string }
  | { readonly available: false; readonly note: string };

export async function simulateBalanceDelta(
  network: Network,
  agent: Address,
  safe: Address,
  rolesModifier: Address,
  calldata: Hex,
): Promise<BalanceDelta> {
  const client = publicClientFor(network);
  const usdc = getAddress(USDC[network.chainId]);
  const balanceOfSafe = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [safe],
  });

  try {
    /**
     * Three calls in one simulated block: read the Safe's balance, run the call as the
     * agent, read it again.
     *
     * Not viem's `traceAssetChanges`, which reports changes for the *account* that sends
     * — here the agent EOA, whose balance does not move. The account whose balance
     * matters is the Safe, and the only way to ask about it is to ask before and after.
     */
    const simulated = (await client.request({
      method: "eth_simulateV1" as never,
      params: [
        {
          blockStateCalls: [
            {
              calls: [
                { from: agent, to: usdc, input: balanceOfSafe },
                { from: agent, to: rolesModifier, input: calldata },
                { from: agent, to: usdc, input: balanceOfSafe },
              ],
            },
          ],
          validation: false,
          traceTransfers: false,
        },
        "latest",
      ] as never,
    })) as readonly { calls: readonly { status: string; returnData: Hex }[] }[];

    const calls = simulated[0]?.calls;
    if (calls === undefined || calls.length < 3) {
      return { available: false, note: "the node returned no simulation result" };
    }

    const [beforeCall, execCall, afterCall] = calls;
    if (execCall?.status !== "0x1") {
      return {
        available: false,
        note: "the call itself would fail, so there is no delta to show",
      };
    }

    const before = BigInt(beforeCall?.returnData ?? "0x0");
    const after = BigInt(afterCall?.returnData ?? "0x0");
    const diff = after - before;

    return {
      available: true,
      usdc: `${diff > 0n ? "+" : ""}${formatUnits(diff, USDC_DECIMALS)}`,
      note: `${formatUnits(before, USDC_DECIMALS)} → ${formatUnits(after, USDC_DECIMALS)} USDC in the Safe`,
    };
  } catch (error) {
    logEvent("review.delta.unavailable", { reason: String(error).split("\n")[0] });
    return {
      available: false,
      note: "this node cannot simulate asset changes — no delta is shown rather than a guessed one",
    };
  }
}
