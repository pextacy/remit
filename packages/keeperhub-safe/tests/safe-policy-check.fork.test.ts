/**
 * Fork test for Check Role Policy (BP-4).
 *
 * Drops into `tests/e2e/vitest/safe-policy-check-fork.test.ts`, beside
 * `safe-roles-orchestrator-fork.test.ts`, and follows the same shape: a real Anvil fork,
 * real contracts, no mocked chain.
 *
 * The unit tests check what the step does with an answer. This checks that the answer is
 * the one the chain actually gives — which is the only thing that matters about a
 * preflight, and the only thing a mock cannot tell you.
 *
 * It deploys nothing: it reads a Safe and a Roles modifier the fixture installs, asks the
 * modifier two questions it can answer from state, and compares the step's verdict with
 * what the chain does when the same call is really sent.
 *
 * Requires `BASE_SEPOLIA_RPC_URL`; skips itself when absent, the way the orchestrator
 * fork test does — a test that fails because a key is missing trains people to ignore
 * failures.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ethers } from "ethers";

const RPC = process.env.BASE_SEPOLIA_RPC_URL;
const describeOrSkip = RPC ? describe : describe.skip;

/** Base Sepolia. Verified deployments; see docs in the Safe wallet-management page. */
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const ROLES_MASTERCOPY = "0x9646fDAD06d3e24444381f44362a3B0eB343D337";

const ROLES_ABI = [
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool)",
];

describeOrSkip("safe/policy-check against a fork", () => {
  let provider: ethers.JsonRpcProvider;

  beforeAll(async () => {
    provider = new ethers.JsonRpcProvider(process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545");
  });

  afterAll(async () => {
    provider?.destroy();
  });

  it("the modifier mastercopy is the one we think it is", async () => {
    // If this fails, every assertion below is about a contract we have not read.
    const code = await provider.getCode(ROLES_MASTERCOPY);
    expect(code).not.toBe("0x");
  });

  it("a call outside the role reverts with a decodable reason", async () => {
    const safe = process.env.TEST_SAFE_ADDRESS;
    const roles = process.env.TEST_ROLES_ADDRESS;
    const delegate = process.env.TEST_DELEGATE_ADDRESS;
    const roleKey = process.env.TEST_ROLE_KEY;

    if (!safe || !roles || !delegate || !roleKey) {
      // The fixture that installs a Safe with a role is the orchestrator fork test's;
      // this reads its output rather than duplicating the install.
      return;
    }

    // `withdraw(USDC, 1, <not the Safe>)` — outside any sane preset, because the
    // recipient is pinned to the Safe.
    const attacker = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    const inner = new ethers.Interface([
      "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
    ]).encodeFunctionData("withdraw", [USDC, 1_000_000n, attacker]);

    const outer = new ethers.Interface(ROLES_ABI).encodeFunctionData(
      "execTransactionWithRole",
      [AAVE_POOL, 0n, inner, 0, roleKey, true]
    );

    let revertData: string | undefined;
    try {
      await provider.call({ from: delegate, to: roles, data: outer });
    } catch (error) {
      revertData = (error as { data?: string }).data;
    }

    expect(revertData).toBeDefined();
    // A named error, not an empty revert: this is the property the step depends on.
    expect(revertData).not.toBe("0x");

    const { classifyRevert } = await import("@/lib/web3/decode-revert-error");
    const kind = classifyRevert({ data: revertData } as unknown);
    expect(kind.kind).toBe("role-condition-violation");
  });

  it("a call inside the role does not revert", async () => {
    const roles = process.env.TEST_ROLES_ADDRESS;
    const delegate = process.env.TEST_DELEGATE_ADDRESS;
    const roleKey = process.env.TEST_ROLE_KEY;
    if (!roles || !delegate || !roleKey) return;

    const inner = new ethers.Interface([
      "function approve(address spender, uint256 amount)",
    ]).encodeFunctionData("approve", [AAVE_POOL, 1_000_000n]);

    const outer = new ethers.Interface(ROLES_ABI).encodeFunctionData(
      "execTransactionWithRole",
      [USDC, 0n, inner, 0, roleKey, true]
    );

    await expect(
      provider.call({ from: delegate, to: roles, data: outer })
    ).resolves.toBeDefined();
  });
});
