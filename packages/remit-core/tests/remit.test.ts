/**
 * The Remit document: its digest, its signatures, and the money arithmetic underneath.
 *
 * `remitHash` is the primary key of the whole system. A third party must be able to
 * re-derive it from the committed bytes (PRD.md RM-2), so the vector below is pinned: a
 * change to it is a change to every receipt ever written.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { hashTypedData, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  REMIT_DOMAIN_NAME,
  REMIT_DOMAIN_VERSION,
  REMIT_TYPE_STRING,
  REMIT_TYPES,
  remitDigest,
  remitTypedData,
} from "../src/eip712/remit.js";
import { verifyRemitSignatures } from "../src/eip712/signatures.js";
import { limitsHash, limitsSchema } from "../src/schema/limits.js";
import { microsToUsd, usdToMicros } from "../src/schema/primitives.js";
import { remitSchema } from "../src/schema/remit.js";
import { LIMITS, limitsFor, NOW, REMIT, remitFor, SAFE } from "./fixtures.js";

describe("the EIP-712 digest", () => {
  test("is reproducible from the document alone", () => {
    assert.equal(remitDigest(REMIT), remitDigest(remitSchema.parse({ ...REMIT })));
  });

  test("matches a vector a second implementation produced", () => {
    // Not recorded from viem and pinned: computed independently with foundry's `cast`,
    // from the EIP-712 definition rather than from any shared code, and found to agree.
    // One library agreeing with itself is not evidence; two are.
    //
    //   cast keccak 0x1901<domainSeparator><structHash>
    //
    // `pnpm --filter ops remit:verify-digest` does the same for a real Remit.
    assert.equal(
      remitDigest(REMIT),
      "0x8a014fd547313b11ac984fa0c811d83acce9f3b75852d3537b241c8141656f15",
    );
  });

  test("the type string and the field list are the same statement", () => {
    const rendered = `Remit(${REMIT_TYPES.Remit.map((f) => `${f.type} ${f.name}`).join(",")})`;
    assert.equal(rendered, REMIT_TYPE_STRING);
  });

  test("the verifying contract is the Safe — the authority being delegated from", () => {
    const typed = remitTypedData(REMIT);
    assert.equal(typed.domain.verifyingContract, SAFE);
    assert.equal(typed.domain.name, REMIT_DOMAIN_NAME);
    assert.equal(typed.domain.version, REMIT_DOMAIN_VERSION);
    assert.equal(typed.domain.chainId, REMIT.chainId);
  });

  test("every field changes the digest", () => {
    const changes: Partial<typeof REMIT>[] = [
      { strategyHash: `0x${"33".repeat(32)}` },
      { workflowHash: `0x${"33".repeat(32)}` },
      { rolesModifier: "0x000000000000000000000000000000000000dEaD" },
      { roleKey: `0x${"44".repeat(32)}` },
      { notBefore: REMIT.notBefore + 1 },
      { notAfter: REMIT.notAfter + 1 },
      { nonce: "2" },
    ];
    for (const change of changes) {
      const altered = remitSchema.parse({ ...REMIT, ...change });
      assert.notEqual(remitDigest(altered), remitDigest(REMIT), JSON.stringify(change));
    }
  });

  test("a Remit for another chain is a different document", () => {
    const mainnet = remitSchema.parse({ ...REMIT, chainId: 8453 });
    assert.notEqual(remitDigest(mainnet), remitDigest(REMIT));
  });

  test("it is the standard 0x1901 construction, not something of our own", () => {
    const typed = remitTypedData(REMIT);
    assert.equal(remitDigest(REMIT), hashTypedData(typed));
  });
});

describe("the Remit document refuses what it cannot mean", () => {
  test("an expiry before it begins", () => {
    assert.throws(() => remitSchema.parse({ ...REMIT, notAfter: REMIT.notBefore - 1 }));
  });

  test("a timestamp in milliseconds", () => {
    assert.throws(() => remitSchema.parse({ ...REMIT, notBefore: Date.now() }));
  });

  test("an unknown chain", () => {
    assert.throws(() => remitSchema.parse({ ...REMIT, chainId: 1 }));
  });

  test("a field nobody declared", () => {
    assert.throws(() => remitSchema.parse({ ...REMIT, bypass: true }));
  });

  test("a nonce that is not an unsigned integer", () => {
    assert.throws(() => remitSchema.parse({ ...REMIT, nonce: "-1" }));
    assert.throws(() => remitSchema.parse({ ...REMIT, nonce: 1 }));
  });
});

describe("limits", () => {
  test("hash reproducibly, whatever order the keys arrive in", () => {
    const reversed = Object.fromEntries(Object.entries(LIMITS).reverse());
    assert.equal(limitsHash(limitsSchema.parse(reversed)), limitsHash(LIMITS));
  });

  test("refuse a cap that is not a USD amount", () => {
    for (const cap of ["abc", "1e6", "5,00", "-5", "5.0000001", ""]) {
      assert.throws(() => limitsFor({ perTxCapUsd: cap }), /not a USD amount/, cap);
    }
  });

  test("refuse an empty allowlist — a list of nothing permits nothing, so say so", () => {
    assert.throws(() => limitsFor({ allowedRecipients: [] }));
    assert.throws(() => limitsFor({ allowedTargets: [] }));
    assert.throws(() => limitsFor({ allowedIntentKinds: [] }));
  });

  test("refuse a selector that is not a function signature", () => {
    assert.throws(() => limitsFor({ allowedSelectors: ["0xa9059cbb"] }));
  });

  test("bind into the Remit, so widening one without the other is visible", () => {
    const widened = limitsFor({ dailyCapUsd: "1000" });
    assert.notEqual(limitsHash(widened), REMIT.limitsHash);
    assert.equal(remitFor(widened).limitsHash, limitsHash(widened));
  });
});

describe("money is integer micro-dollars, never a float", () => {
  test("converts exactly", () => {
    assert.equal(usdToMicros("5"), 5_000_000n);
    assert.equal(usdToMicros("5.25"), 5_250_000n);
    assert.equal(usdToMicros("0.000001"), 1n);
    assert.equal(usdToMicros("0"), 0n);
  });

  test("round trips", () => {
    for (const amount of ["0", "1", "5.25", "0.000001", "999999999"]) {
      assert.equal(microsToUsd(usdToMicros(amount)), amount);
    }
  });

  test("a cap of 5 is never 4.999999", () => {
    // The arithmetic a floating-point path gets wrong, which is a cap that fails open.
    assert.equal(usdToMicros("0.1") + usdToMicros("0.2"), usdToMicros("0.3"));
  });

  test("holds amounts past 2^53", () => {
    assert.equal(usdToMicros("10000000000000"), 10_000_000_000_000_000_000n);
  });
});

describe("owner signatures are attribution, checked against current owners", () => {
  const [ownerA, ownerB, ownerC] = [
    privateKeyToAccount(`0x${"11".repeat(32)}`),
    privateKeyToAccount(`0x${"22".repeat(32)}`),
    privateKeyToAccount(`0x${"33".repeat(32)}`),
  ] as const;
  const owners = [ownerA, ownerB, ownerC];
  const addresses = owners.map((owner) => owner.address);
  const typed = remitTypedData(REMIT);

  test("a threshold's worth of owner signatures verifies", async () => {
    const signatures = await Promise.all(
      owners.slice(0, 2).map((owner) => owner.signTypedData(typed)),
    );
    const check = await verifyRemitSignatures({
      remit: REMIT,
      signatures,
      owners: addresses,
      threshold: 2,
    });
    assert.equal(check.ok, true);
    assert.equal(check.valid.length, 2);
  });

  test("one owner signing twice does not meet a threshold of two", async () => {
    // The whole point of a threshold is that it is a count of people, not of signatures.
    const one = await ownerA.signTypedData(typed);
    const check = await verifyRemitSignatures({
      remit: REMIT,
      signatures: [one, one],
      owners: addresses,
      threshold: 2,
    });
    assert.equal(check.ok, false);
    assert.equal(check.valid.length, 1);
  });

  test("a signature from someone who is not an owner is reported, not ignored", async () => {
    const stranger = privateKeyToAccount(`0x${"99".repeat(32)}`);
    const signatures = await Promise.all([
      ownerA.signTypedData(typed),
      ownerB.signTypedData(typed),
      stranger.signTypedData(typed),
    ]);
    const check = await verifyRemitSignatures({
      remit: REMIT,
      signatures,
      owners: addresses,
      threshold: 2,
    });
    assert.equal(check.ok, false);
    assert.equal(check.strangers.length, 1);
    assert.match(check.reason, /not from a current Safe owner/);
  });

  test("a signature over a different Remit does not carry to this one", async () => {
    const other = remitFor(LIMITS, { nonce: "2" });
    const signature = await ownerA.signTypedData(remitTypedData(other));
    const check = await verifyRemitSignatures({
      remit: REMIT,
      signatures: [signature],
      owners: addresses,
      threshold: 1,
    });
    assert.equal(check.ok, false);
  });

  test("a malformed signature is counted rather than thrown on", async () => {
    const check = await verifyRemitSignatures({
      remit: REMIT,
      signatures: ["0xdeadbeef"],
      owners: addresses,
      threshold: 1,
    });
    assert.equal(check.ok, false);
    assert.equal(check.malformed, 1);
  });

  test("an owner removed since signing no longer carries authority", async () => {
    const signature = await ownerA.signTypedData(typed);
    const check = await verifyRemitSignatures({
      remit: REMIT,
      signatures: [signature],
      owners: [ownerB.address, ownerC.address],
      threshold: 1,
    });
    assert.equal(check.ok, false);
    assert.equal(check.strangers.length, 1);
  });
});

describe("the strategy hash is the file's bytes", () => {
  test("one byte changes it", () => {
    assert.notEqual(
      keccak256(toBytes("def decide():\n    return None\n")),
      keccak256(toBytes("def decide():\n    return None")),
    );
  });

  test("and NOW is fixed, so these tests never depend on the clock", () => {
    assert.equal(NOW, 1_800_000_000);
  });
});
