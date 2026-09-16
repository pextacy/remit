/**
 * The receipt chain — the one thing in this project a stranger runs.
 *
 * Acceptance criterion 3 is that someone with a clone and no access to anything of ours
 * can re-derive every hash and catch an edit. These tests are that stranger: they build a
 * chain, then try to change it in each of the ways a chain can be changed, and assert
 * that the verifier says so.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  GENESIS_PREV_HASH,
  type Receipt,
  type ReceiptBody,
  receiptHash,
  receiptSchema,
  sealReceipt,
  unparseableIntent,
  verifyReceiptChain,
} from "../src/receipts/index.js";
import {
  appendReceipt,
  chainHead,
  readChain,
  verifyChainAt,
} from "../src/receipts/store.js";
import {
  AGENT,
  CHAIN,
  LIMITS,
  NOW,
  REMIT,
  REMIT_HASH,
  ROLE_KEY,
  ROLES,
  SAFE,
  usdc,
} from "./fixtures.js";

const temporaries: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "remit-receipts-"));
  temporaries.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

type Body = Omit<ReceiptBody, "sequence" | "prevHash">;

function body(overrides: Partial<Body> = {}): Body {
  return {
    version: 1,
    at: NOW,
    network: "anvil",
    chainId: CHAIN,
    remitHash: REMIT_HASH,
    strategyHash: REMIT.strategyHash,
    workflowHash: REMIT.workflowHash,
    limitsHash: REMIT.limitsHash,
    roleKey: ROLE_KEY,
    safe: SAFE,
    rolesModifier: ROLES,
    agent: AGENT,
    intent: { kind: "supply", asset: "USDC", amount: usdc("1"), onBehalfOf: SAFE },
    action: null,
    gates: [{ gate: "G1", outcome: "refused", code: "OUT_OF_REMIT_RECIPIENT" }],
    outcome: "rejected_g1",
    submission: {
      path: "none",
      executionId: null,
      workflowId: null,
      txHash: null,
      explorer: null,
      gasUsed: null,
    },
    ...overrides,
  };
}

function chainOf(dir: string, count: number): Receipt[] {
  return Array.from(
    { length: count },
    (_, index) => appendReceipt(dir, body({ at: NOW + index })).receipt,
  );
}

/** Rewrite one receipt file on disk, the way an editor would. */
function edit(dir: string, file: string, patch: Record<string, unknown>): void {
  const path = join(dir, file);
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

describe("sealing", () => {
  test("a sealed receipt's hash is over its own bytes", () => {
    const sealed = sealReceipt({ ...body(), sequence: 0, prevHash: GENESIS_PREV_HASH });
    const { selfHash, ...rest } = sealed;
    assert.equal(receiptHash(rest), selfHash);
  });

  test("it survives a round trip through JSON, which is how it is stored", () => {
    const sealed = sealReceipt({ ...body(), sequence: 0, prevHash: GENESIS_PREV_HASH });
    const reread = receiptSchema.parse(JSON.parse(JSON.stringify(sealed)));
    const { selfHash, ...rest } = reread;
    assert.equal(receiptHash(rest), selfHash);
  });

  test("a hash spelled in upper case still reproduces", () => {
    // The schemas normalise; the hash is taken after they have. Sealing the caller's
    // spelling instead would produce a receipt that fails to verify for no reason.
    const sealed = sealReceipt({
      ...body({
        remitHash: REMIT_HASH.toUpperCase().replace("0X", "0x") as `0x${string}`,
      }),
      sequence: 0,
      prevHash: GENESIS_PREV_HASH,
    });
    const { selfHash, ...rest } = sealed;
    assert.equal(receiptHash(rest), selfHash);
    assert.equal(sealed.remitHash, REMIT_HASH);
  });

  test("a refusal of something that is not an intent is still recordable", () => {
    // The commonest refusal a poisoned strategy earns. A receipt that could not hold it
    // would be a receipt that vanished exactly when it mattered.
    const poisoned = { kind: "supply", asset: "USDC", amount: 5.5, data: "0xdead" };
    const sealed = sealReceipt({
      ...body({ intent: unparseableIntent(poisoned) }),
      sequence: 0,
      prevHash: GENESIS_PREV_HASH,
    });
    assert.equal(sealed.intent.kind, "unparseable");
    assert.match(JSON.stringify(sealed.intent), /0xdead/);
    assert.match(JSON.stringify(sealed.intent), /5\.5/);
  });
});

describe("appending", () => {
  let dir = "";
  beforeEach(() => {
    dir = scratch();
  });

  test("the first receipt links to genesis", () => {
    const { receipt } = appendReceipt(dir, body());
    assert.equal(receipt.sequence, 0);
    assert.equal(receipt.prevHash, GENESIS_PREV_HASH);
  });

  test("each one links to the one before it", () => {
    const [first, second, third] = chainOf(dir, 3);
    assert.equal(second?.prevHash, first?.selfHash);
    assert.equal(third?.prevHash, second?.selfHash);
    assert.deepEqual([first?.sequence, second?.sequence, third?.sequence], [0, 1, 2]);
  });

  test("the writer cannot choose its own place in the chain", () => {
    // Passing a sequence and a prevHash is how a writer rewrites history. The store
    // assigns both, so the extra fields are simply not part of the input it accepts.
    const { receipt } = appendReceipt(dir, {
      ...body(),
      ...({ sequence: 99, prevHash: `0x${"ff".repeat(32)}` } as Record<string, never>),
    });
    assert.equal(receipt.sequence, 0);
    assert.equal(receipt.prevHash, GENESIS_PREV_HASH);
  });

  test("files are named so that they sort into chain order", () => {
    chainOf(dir, 12);
    const names = readdirSync(dir).sort();
    assert.equal(names.length, 12);
    names.forEach((name, index) => {
      assert.equal(name.slice(0, 4), String(index).padStart(4, "0"));
    });
  });

  test("the ten-thousandth receipt is part of the chain, not the end of it", () => {
    // `appendReceipt` pads the sequence to a *minimum* of four digits, so #10000 is
    // written as `10000-…`. The reader's pattern demanded exactly four and its sort was
    // lexicographic, so every record from there on was invisible: `verify` re-derived
    // the first ten thousand hashes, found them sound, and answered yes to a chain whose
    // end it had never read. A verifier that passes on a truncated chain is the one
    // failure this may not have, and it arrived silently at a round number.
    //
    // Written directly rather than by appending ten thousand receipts: what is under
    // test is the reader, and the file names are the store's own.
    const sealed = [9998, 9999, 10_000, 10_001].map((sequence) =>
      sealReceipt({ ...body(), sequence, prevHash: GENESIS_PREV_HASH }),
    );
    for (const receipt of sealed) {
      writeFileSync(
        join(dir, `${String(receipt.sequence).padStart(4, "0")}-executed.json`),
        JSON.stringify(receipt),
      );
    }

    const read = readChain(dir);
    assert.equal(read.length, 4, "a record past 9999 was dropped");
    assert.deepEqual(
      read.map((entry) => entry.file),
      [
        "9998-executed.json",
        "9999-executed.json",
        "10000-executed.json",
        "10001-executed.json",
      ],
      "the chain was ordered by name rather than by sequence",
    );
    // And the head is the last record rather than the last *name*.
    assert.equal(chainHead(dir).sequence, 10_002);
  });

  test("an unreadable head refuses the next append rather than starting a second chain", () => {
    chainOf(dir, 1);
    writeFileSync(join(dir, "0000-rejected_g1.json"), '{"half":"written"');
    assert.throws(() => chainHead(dir), /not a readable receipt/);
    assert.throws(() => appendReceipt(dir, body()), /not a readable receipt/);
  });
});

describe("verifying", () => {
  let dir = "";
  beforeEach(() => {
    dir = scratch();
  });

  test("a chain this code wrote verifies", () => {
    chainOf(dir, 4);
    const result = verifyChainAt(dir);
    assert.equal(result.ok, true);
    assert.equal(result.count, 4);
    assert.deepEqual(result.problems, []);
  });

  test("an empty directory is a chain with nothing in it", () => {
    assert.equal(verifyChainAt(dir).ok, true);
    assert.equal(verifyChainAt(dir).count, 0);
  });

  test("a directory that does not exist is a typo, not an empty chain", () => {
    // The one failure a verifier must never have: passing because it looked nowhere.
    assert.throws(() => verifyChainAt(join(dir, "nope")), /no receipt directory/);
    assert.deepEqual(readChain(join(dir, "nope"), { allowMissing: true }), []);
  });

  test("an edited field is caught by the receipt's own hash", () => {
    chainOf(dir, 3);
    edit(dir, "0001-rejected_g1.json", { outcome: "executed" });
    const result = verifyChainAt(dir);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => /selfHash does not match/.test(problem.problem)),
    );
  });

  test("an edit re-sealed with a valid hash is caught by the link", () => {
    // The sophisticated version: fix the receipt's own hash so it is internally
    // consistent. The chain still notices, because the next receipt commits to the old one.
    chainOf(dir, 3);
    const path = join(dir, "0001-rejected_g1.json");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Receipt;
    const { selfHash: _ignored, ...rest } = { ...receipt, network: "base" };
    writeFileSync(
      path,
      `${JSON.stringify({ ...rest, selfHash: receiptHash(rest as ReceiptBody) }, null, 2)}\n`,
    );

    const result = verifyChainAt(dir);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => /prevHash does not link/.test(problem.problem)),
    );
  });

  test("a removed receipt leaves a gap that shows", () => {
    chainOf(dir, 4);
    rmSync(join(dir, "0001-rejected_g1.json"));
    const result = verifyChainAt(dir);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => /sequence is out of order/.test(problem.problem)),
    );
  });

  test("a receipt that is not a receipt is reported rather than skipped", () => {
    chainOf(dir, 2);
    edit(dir, "0001-rejected_g1.json", { outcome: "something-else" });
    const result = verifyChainAt(dir);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) =>
        /does not match the schema/.test(problem.problem),
      ),
    );
  });

  test("the documents are re-derived, not believed", () => {
    chainOf(dir, 2);
    const result = verifyChainAt(dir, { remit: REMIT, limits: LIMITS });
    assert.equal(result.ok, true);
  });

  test("documents describing a Remit this chain never used are caught", () => {
    // A reissued Remit legitimately leaves older records naming the previous one, so a
    // receipt under another Remit is history rather than damage. Documents that *no*
    // record names are a different thing: the wrong file, or a path typo — and a
    // verifier that answered "yes" to that would be answering about nothing.
    chainOf(dir, 2);
    // In force while the chain was being written, and named by nothing in it.
    const other = { ...REMIT, nonce: "2", notBefore: REMIT.notBefore };
    const result = verifyChainAt(dir, { remit: other, limits: LIMITS });
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) =>
        /no receipt in this chain was written under the Remit supplied/.test(
          problem.problem,
        ),
      ),
    );
    assert.equal(result.uncheckedAgainstDocuments.length, 2);
  });

  test("a limits document that does not hash to what the Remit binds is caught", () => {
    chainOf(dir, 1);
    const widened = { ...LIMITS, dailyCapUsd: "1000" };
    const result = verifyChainAt(dir, { remit: REMIT, limits: widened });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.file === "remit"));
  });
});

describe("a receipt cannot claim more than it can show", () => {
  test("an execution with no transaction hash", () => {
    const stored = [
      {
        file: "0000-executed.json",
        receipt: sealReceipt({
          ...body({
            outcome: "executed",
            action: {
              target: SAFE,
              signature: "supply(address,uint256,address,uint16)",
              selector: "0x617ba037",
              description: "supply 1 USDC",
              usd: "1",
            },
            gates: [{ gate: "G4", outcome: "pass" }],
          }),
          sequence: 0,
          prevHash: GENESIS_PREV_HASH,
        }),
      },
    ];
    const result = verifyReceiptChain(stored);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => /no transaction hash/.test(problem.problem)),
    );
  });

  test("an execution with no compiled action", () => {
    const stored = [
      {
        file: "0000-executed.json",
        receipt: sealReceipt({
          ...body({
            outcome: "executed",
            gates: [{ gate: "G4", outcome: "pass" }],
            submission: {
              path: "ops-direct",
              executionId: null,
              workflowId: null,
              txHash: `0x${"ab".repeat(32)}`,
              explorer: null,
              gasUsed: "21000",
            },
          }),
          sequence: 0,
          prevHash: GENESIS_PREV_HASH,
        }),
      },
    ];
    const result = verifyReceiptChain(stored);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => /no compiled action/.test(problem.problem)),
    );
  });

  test("a KeeperHub submission with no execution id to correlate on", () => {
    const stored = [
      {
        file: "0000-unresolved.json",
        receipt: sealReceipt({
          ...body({
            outcome: "unresolved",
            submission: {
              path: "keeperhub",
              executionId: null,
              workflowId: null,
              txHash: null,
              explorer: null,
              gasUsed: null,
            },
          }),
          sequence: 0,
          prevHash: GENESIS_PREV_HASH,
        }),
      },
    ];
    const result = verifyReceiptChain(stored);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /no executionId/.test(problem.problem)));
  });
});
