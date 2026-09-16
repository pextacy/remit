/**
 * G1 — every refusal it claims to make, and the one thing it must never do.
 *
 * The gate is pure: `now` and the ledger arrive as arguments, so every case below is a
 * function call with no chain, no clock and no filesystem behind it. That is the property
 * being tested as much as any individual refusal — a gate that needed a network would be
 * a gate that could be made to fail open by unplugging one.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { BASE } from "../src/chain/addresses.js";
import { limitsHash } from "../src/schema/limits.js";
import { checkEnvelope } from "../src/verify/envelope.js";
import type { LedgerEntry } from "../src/verify/ledger.js";
import {
  ATTACKER,
  CHAIN,
  LIMITS,
  limitsFor,
  NOW,
  POOL,
  REMIT,
  remitFor,
  SAFE,
  usdc,
} from "./fixtures.js";

function check(
  intent: unknown,
  options: Partial<Parameters<typeof checkEnvelope>[0]> = {},
) {
  return checkEnvelope({
    remit: REMIT,
    limits: LIMITS,
    chainId: CHAIN,
    intent,
    now: NOW,
    ledger: [],
    ...options,
  });
}

/** The refusal code, or "pass". One word per case, which is what the tests assert on. */
function outcome(result: ReturnType<typeof checkEnvelope>): string {
  return result.ok ? "pass" : result.error.code;
}

const supply = (amount: string, onBehalfOf = SAFE) => ({
  kind: "supply",
  asset: "USDC",
  amount,
  onBehalfOf,
});

describe("G1 admits what the Remit permits", () => {
  test("a supply to the Safe, inside every cap", () => {
    const result = check(supply(usdc("5")));
    assert.equal(outcome(result), "pass");
    assert.ok(result.ok);
    assert.equal(result.decision.usd, "5");
    assert.equal(result.decision.action.target, POOL);
    assert.equal(result.decision.entry.kind, "supply");
  });

  test("a withdraw back to the Safe", () => {
    const result = check({
      kind: "withdraw",
      asset: "USDC",
      amount: usdc("2"),
      to: SAFE,
    });
    assert.equal(outcome(result), "pass");
  });

  test("an approve of the venue the preset scopes", () => {
    const result = check({
      kind: "approve",
      asset: "USDC",
      amount: usdc("5"),
      spender: POOL,
    });
    assert.equal(outcome(result), "pass");
  });

  test("headroom is what is left of the daily cap after this action", () => {
    const result = check(supply(usdc("5")));
    assert.ok(result.ok);
    assert.equal(result.decision.headroomMicros, 20_000_000n);
  });
});

describe("G1 refuses what is not an intent", () => {
  test("an intent carrying raw calldata — the injection shape", () => {
    const result = check({ ...supply(usdc("1")), data: "0xa9059cbb" });
    assert.equal(outcome(result), "INTENT_MALFORMED");
  });

  test("an asset named by address instead of symbol", () => {
    const result = check({
      kind: "supply",
      asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      amount: usdc("1"),
      onBehalfOf: SAFE,
    });
    assert.equal(outcome(result), "INTENT_MALFORMED");
  });

  test("an amount as a float", () => {
    assert.equal(outcome(check(supply(5.5 as unknown as string))), "INTENT_MALFORMED");
  });

  test("a negative amount", () => {
    assert.equal(outcome(check(supply("-5000000"))), "INTENT_MALFORMED");
  });

  test("an amount with a leading zero, which is a second spelling of one number", () => {
    assert.equal(outcome(check(supply("0005000000"))), "INTENT_MALFORMED");
  });

  test("a kind nobody defined", () => {
    assert.equal(
      outcome(check({ kind: "transfer", asset: "USDC", amount: "1", to: SAFE })),
      "INTENT_MALFORMED",
    );
  });

  test("nothing at all", () => {
    assert.equal(outcome(check(undefined)), "INTENT_MALFORMED");
    assert.equal(outcome(check(null)), "INTENT_MALFORMED");
    assert.equal(outcome(check("supply 5 USDC")), "INTENT_MALFORMED");
  });

  test("the refusal names a field a person can act on", () => {
    const result = check({ ...supply(usdc("1")), data: "0x" });
    assert.ok(!result.ok);
    assert.notEqual(result.error.field, "");
    assert.ok(result.error.message.length > 0);
  });
});

describe("G1 refuses what the Remit does not permit", () => {
  test("a withdraw to an attacker", () => {
    const result = check({
      kind: "withdraw",
      asset: "USDC",
      amount: usdc("1"),
      to: ATTACKER,
    });
    assert.equal(outcome(result), "OUT_OF_REMIT_RECIPIENT");
  });

  test("a supply credited to an attacker", () => {
    assert.equal(outcome(check(supply(usdc("1"), ATTACKER))), "OUT_OF_REMIT_RECIPIENT");
  });

  test("an approve to an attacker is a spender question, not a recipient one", () => {
    // The list of recipients contains the Safe, and always will. Checking a spender
    // against it would let this pass.
    const result = check({
      kind: "approve",
      asset: "USDC",
      amount: usdc("1"),
      spender: ATTACKER,
    });
    assert.equal(outcome(result), "OUT_OF_REMIT_SPENDER");
  });

  test("an approve to the Safe itself is still not a permitted spender", () => {
    const result = check({
      kind: "approve",
      asset: "USDC",
      amount: usdc("1"),
      spender: SAFE,
    });
    assert.equal(outcome(result), "OUT_OF_REMIT_SPENDER");
  });

  test("a kind the Remit does not grant", () => {
    const limits = limitsFor({ allowedIntentKinds: ["approve", "supply"] });
    const result = check(
      { kind: "withdraw", asset: "USDC", amount: "1", to: SAFE },
      {
        limits,
        remit: remitFor(limits),
      },
    );
    assert.equal(outcome(result), "OUT_OF_REMIT_KIND");
  });

  test("a venue the Remit does not list", () => {
    const limits = limitsFor({
      allowedTargets: [LIMITS.allowedTargets[0] as `0x${string}`],
    });
    const result = check(supply(usdc("1")), { limits, remit: remitFor(limits) });
    assert.equal(outcome(result), "OUT_OF_REMIT_TARGET");
  });

  test("a function the Remit does not list", () => {
    const limits = limitsFor({ allowedSelectors: ["approve(address,uint256)"] });
    const result = check(supply(usdc("1")), { limits, remit: remitFor(limits) });
    assert.equal(outcome(result), "OUT_OF_REMIT_SELECTOR");
  });

  test("a recipient that differs only in case is the same address", () => {
    const result = check(supply(usdc("1"), SAFE.toLowerCase() as `0x${string}`));
    assert.equal(outcome(result), "pass");
  });
});

describe("G1 refuses what is too large, too often, or too late", () => {
  test("above the per-transaction cap", () => {
    assert.equal(outcome(check(supply(usdc("6")))), "REMIT_CAP_EXCEEDED_PER_TX");
  });

  test("exactly at the per-transaction cap is inside it", () => {
    assert.equal(outcome(check(supply(usdc("5")))), "pass");
  });

  test("above the rolling daily cap, counting what the ledger already holds", () => {
    const ledger: LedgerEntry[] = Array.from({ length: 5 }, () => ({
      at: NOW - 60,
      usdMicros: usdc("5"),
      kind: "supply" as const,
    }));
    assert.equal(
      outcome(check(supply(usdc("5")), { ledger })),
      "REMIT_CAP_EXCEEDED_DAILY",
    );
  });

  test("spend that fell out of the 24h window no longer counts", () => {
    const ledger: LedgerEntry[] = Array.from({ length: 5 }, () => ({
      at: NOW - 86_401,
      usdMicros: usdc("5"),
      kind: "supply" as const,
    }));
    assert.equal(outcome(check(supply(usdc("5")), { ledger })), "pass");
  });

  test("a withdraw does not consume the daily cap — it brings funds back", () => {
    const ledger: LedgerEntry[] = Array.from({ length: 5 }, () => ({
      at: NOW - 60,
      usdMicros: usdc("5"),
      kind: "withdraw" as const,
    }));
    assert.equal(
      outcome(
        check(
          { kind: "withdraw", asset: "USDC", amount: usdc("5"), to: SAFE },
          { ledger },
        ),
      ),
      "pass",
    );
  });

  test("above the rate limit", () => {
    const ledger: LedgerEntry[] = Array.from({ length: 6 }, () => ({
      at: NOW - 60,
      usdMicros: usdc("0.1"),
      kind: "approve" as const,
    }));
    assert.equal(
      outcome(check(supply(usdc("1")), { ledger })),
      "REMIT_RATE_LIMIT_EXCEEDED",
    );
  });

  test("actions older than the hour do not count against the rate limit", () => {
    const ledger: LedgerEntry[] = Array.from({ length: 6 }, () => ({
      at: NOW - 3601,
      usdMicros: usdc("0.1"),
      kind: "approve" as const,
    }));
    assert.equal(outcome(check(supply(usdc("1")), { ledger })), "pass");
  });

  test("before the Remit is in force", () => {
    assert.equal(
      outcome(check(supply(usdc("1")), { now: REMIT.notBefore - 1 })),
      "REMIT_NOT_YET_VALID",
    );
  });

  test("after it expires", () => {
    assert.equal(
      outcome(check(supply(usdc("1")), { now: REMIT.notAfter + 1 })),
      "REMIT_EXPIRED",
    );
  });

  test("the boundaries themselves are inside the window", () => {
    assert.equal(outcome(check(supply(usdc("1")), { now: REMIT.notBefore })), "pass");
    assert.equal(outcome(check(supply(usdc("1")), { now: REMIT.notAfter })), "pass");
  });
});

describe("G1 refuses a Remit that is not this one", () => {
  test("a testnet Remit used against mainnet", () => {
    assert.equal(
      outcome(check(supply(usdc("1")), { chainId: BASE })),
      "REMIT_CHAIN_MISMATCH",
    );
  });

  test("limits widened after issue, with the hash left alone", () => {
    // The attack this check exists for: edit the document the gate enforces, leave the
    // Remit's hash untouched, and hope nobody re-derives it.
    const widened = limitsFor({ allowedRecipients: [SAFE, ATTACKER] });
    assert.notEqual(limitsHash(widened), REMIT.limitsHash);
    const result = check(
      { kind: "withdraw", asset: "USDC", amount: usdc("1"), to: ATTACKER },
      { limits: widened },
    );
    assert.equal(outcome(result), "REMIT_LIMITS_MISMATCH");
  });
});

describe("G3 is asked for when the action is worth a person's attention", () => {
  test("above the review threshold", () => {
    const result = check(supply(usdc("2")));
    assert.ok(result.ok);
    assert.equal(result.decision.requiresReview, true);
    assert.match(String(result.decision.reviewReason), /review threshold/);
  });

  test("below it, nobody is woken up", () => {
    const result = check(supply(usdc("0.5")));
    assert.ok(result.ok);
    assert.equal(result.decision.requiresReview, false);
    assert.equal(result.decision.reviewReason, undefined);
  });

  test("a changed strategy version is held whatever its size", () => {
    const result = check(supply(usdc("0.5")), {
      seenStrategyHash: `0x${"99".repeat(32)}`,
    });
    assert.ok(result.ok);
    assert.equal(result.decision.requiresReview, true);
    assert.match(String(result.decision.reviewReason), /changed version/);
  });

  test("the same strategy version is not", () => {
    const result = check(supply(usdc("0.5")), { seenStrategyHash: REMIT.strategyHash });
    assert.ok(result.ok);
    assert.equal(result.decision.requiresReview, false);
  });
});
