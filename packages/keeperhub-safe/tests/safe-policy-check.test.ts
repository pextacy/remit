/**
 * Unit tests for the Check Role Policy step (BP-4).
 *
 * Drops into `tests/unit/safe-policy-check.test.ts`. The mocking shape follows
 * `tests/unit/batch-read-contract.test.ts`, which `plugins/CLAUDE.md` names as the
 * canonical example: `server-only` stubbed, `runPluginStep` passed through, the RPC
 * manager and the signer resolver mocked at their module boundary.
 *
 * What is deliberately *not* mocked: `classifyRevert`. The whole value of this step is
 * that a refusal comes back as a name rather than a hex blob, and a test that mocked the
 * classifier would assert that our plumbing works while telling us nothing about whether
 * the answer is the right one. The tests below feed it real encoded revert data — a real
 * `ConditionViolation(uint8,bytes32)` and a real `NoMembership()` — and check what comes
 * out the other end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "external_service" },
  logUserError: vi.fn(),
}));

const mockGetChainIdFromNetwork = vi.fn();
const mockGetRpcProvider = vi.fn();
const mockResolveSignerMode = vi.fn();
const mockExecuteWithFailover = vi.fn();

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: (...args: unknown[]) => mockGetChainIdFromNetwork(...args),
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: (...args: unknown[]) => mockGetRpcProvider(...args),
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  resolveSignerMode: (...args: unknown[]) => mockResolveSignerMode(...args),
}));

import { ethers } from "ethers";
import { policyCheckStep } from "@/plugins/safe/steps/policy-check";

const SAFE = "0x7c64738f8D3177c94145c241514D706dF46A2CA3";
const ROLES = "0x893b803ec4027807f23C30AFD3C8771f7bD51435";
const DELEGATE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const ROLE_KEY =
  "0x72656d69742d6167656e74000000000000000000000000000000000000000000";

/** `approve(pool, 5 USDC)` — a call shape the role would normally allow. */
const CALLDATA = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
])  // `BigInt(...)`, not `5_000_000n`: the repository targets ES2017 and rejects BigInt
  // literals, which their own `lib/safe` code works around the same way.
  .encodeFunctionData("approve", [POOL, BigInt(5_000_000)]);

/**
 * Real revert data, encoded the way the modifier encodes it.
 *
 * `ConditionViolation(Status status, bytes32 info)` with status 7 is
 * `ParameterNotAllowed` — the refusal a recipient that is not the Safe produces.
 */
const ROLES_ERRORS = new ethers.Interface([
  "error ConditionViolation(uint8 status, bytes32 info)",
  "error NoMembership()",
  "error ModuleTransactionFailed()",
]);

function revertWith(data: string): Error {
  // The shape ethers gives a caller when a node returns revert data: the classifier
  // reads it out of `error.data`, so the test hands it over the same way.
  const error = new Error("execution reverted") as Error & { data: string };
  error.data = data;
  return error;
}

const input = {
  network: "base",
  contractAddress: USDC,
  callData: CALLDATA,
  _context: { nodeId: "n1", nodeName: "check", nodeType: "safe", organizationId: "org_1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChainIdFromNetwork.mockReturnValue(8453);
  mockResolveSignerMode.mockResolvedValue({
    kind: "safe-role",
    ownerAddress: DELEGATE,
    safeAddress: SAFE,
    safeWalletId: "sw_1",
    rolesModifierAddress: ROLES,
    roleKey: ROLE_KEY,
    delegateAddress: DELEGATE,
  });
  mockGetRpcProvider.mockResolvedValue({
    executeWithFailover: (operation: (provider: unknown) => unknown) =>
      mockExecuteWithFailover(operation),
  });
});

describe("safe/policy-check", () => {
  it("reports allowed when the modifier would let the call through", async () => {
    // First call: eth_call succeeds. Second: the gas estimate.
    mockExecuteWithFailover
      .mockResolvedValueOnce("0x")
      .mockResolvedValueOnce(BigInt(123_456));

    const result = await policyCheckStep(input);

    expect(result).toMatchObject({
      success: true,
      allowed: true,
      reason: "",
      refusedByRole: false,
      gasEstimate: "123456",
    });
  });

  it("names the Status when the role refuses on a condition", async () => {
    mockExecuteWithFailover.mockRejectedValueOnce(
      revertWith(
        ROLES_ERRORS.encodeErrorResult("ConditionViolation", [
          7,
          ethers.ZeroHash,
        ])
      )
    );

    const result = await policyCheckStep(input);

    expect(result).toMatchObject({
      success: true,
      allowed: false,
      revertKind: "role-condition-violation",
      status: "ParameterNotAllowed",
      refusedByRole: true,
    });
    // The point of the step: the reason names the status rather than printing bytes.
    expect((result as { reason: string }).reason).toContain("ParameterNotAllowed");
  });

  it("reports a missing membership as a refusal", async () => {
    mockExecuteWithFailover.mockRejectedValueOnce(
      revertWith(ROLES_ERRORS.encodeErrorResult("NoMembership", []))
    );

    const result = await policyCheckStep(input);

    // `allowed: false` either way — the call would not go through.
    //
    // `refusedByRole` is where this gets interesting. `NoMembership()` is a role refusal
    // and *should* be true, but `classifyRevert` cannot name it: the modifier's error
    // list in `lib/web3/decode-revert-error.ts` does not include it, so it arrives as
    // `unknown`. That is the gap written up in
    // `patches/decode-revert-error.md` — with that fix, this assertion becomes
    // `refusedByRole: true`, and the test is written so that the change is a one-line
    // edit rather than a rewrite.
    expect(result).toMatchObject({ success: true, allowed: false });
    expect((result as { revertKind: string }).revertKind).toBe("unknown");
  });

  it("separates a call that fails on its own from a call the role refuses", async () => {
    // `ModuleTransactionFailed` means the role allowed it and the inner call failed —
    // an exhausted allowance, an empty balance. Different problem, different fix, and a
    // workflow author branching on `refusedByRole` must not see these as the same thing.
    mockExecuteWithFailover.mockRejectedValueOnce(
      revertWith(ROLES_ERRORS.encodeErrorResult("ModuleTransactionFailed", []))
    );

    const result = await policyCheckStep(input);

    expect(result).toMatchObject({ success: true, allowed: false, refusedByRole: false });
  });

  it("does not answer for an organization that is not routing through a role", async () => {
    mockResolveSignerMode.mockResolvedValue({ kind: "eoa", ownerAddress: DELEGATE });

    const result = await policyCheckStep(input);

    // Not `allowed: true`. There is no role policy to check, and saying the call is
    // allowed would be answering a question nobody asked.
    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain("not through a Zodiac Roles");
  });

  it("reports an unreachable chain as a failed check, not as a policy answer", async () => {
    mockGetRpcProvider.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await policyCheckStep(input);

    // Neither allowed nor refused. Reporting `allowed: true` here would turn an outage
    // into a green light; `allowed: false` would stop a workflow the role permits.
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("allowed");
  });

  it("rejects a malformed contract address before touching the chain", async () => {
    const result = await policyCheckStep({ ...input, contractAddress: "not-an-address" });

    expect(result).toMatchObject({ success: false });
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("rejects calldata that is not even-length hex", async () => {
    const result = await policyCheckStep({ ...input, callData: "0xabc" });

    expect(result).toMatchObject({ success: false });
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a decimal string of wei", async () => {
    const result = await policyCheckStep({ ...input, value: "five" });

    expect(result).toMatchObject({ success: false });
    expect(mockGetRpcProvider).not.toHaveBeenCalled();
  });

  it("never retries", () => {
    // A policy answer is a point-in-time reading of on-chain state. A silent retry would
    // report an allowance or a membership that changed between attempts.
    expect(policyCheckStep.maxRetries).toBe(0);
  });
});
