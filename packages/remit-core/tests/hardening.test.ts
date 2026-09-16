/**
 * The failures this build was found to have, as tests.
 *
 * Every case here is a way the system could be told something false without noticing:
 * two documents that hashed alike, a cap that counted a spend as belonging to tomorrow,
 * a receipt that could be replaced by another with the same sequence, a limits document
 * whose selectors named no function. They are properties of the rules, not of the code
 * that happens to implement them, so they are written against the rule.
 */
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Clearance } from "../src/chain/roles-enums.js";
import {
  canonicalHash,
  canonicalJson,
  microsToUsd,
  NonCanonicalValueError,
  usdToMicros,
} from "../src/index.js";
import { sealReceipt, verifyReceiptChain } from "../src/receipts/chain.js";
import { GENESIS_PREV_HASH } from "../src/receipts/schema.js";
import {
  appendReceipt,
  BrokenChainError,
  ReceiptCollisionError,
  readChain,
} from "../src/receipts/store.js";
import {
  decide,
  enqueueReview,
  readAllDecisions,
  readItems,
  readPending,
} from "../src/review/store.js";
import { diffRole, renderDiff } from "../src/roles/diff.js";
import { buildPreset } from "../src/roles/preset.js";
import { limitsSchema } from "../src/schema/limits.js";
import { LockTimeoutError, withLock, withLockAsync } from "../src/util/lock.js";
import { checkEnvelope } from "../src/verify/envelope.js";
import { countInWindow, DAY_SECONDS, spentMicros } from "../src/verify/ledger.js";
import {
  AGENT,
  LIMITS,
  limitsFor,
  NOW,
  REMIT,
  REMIT_HASH,
  ROLES,
  SAFE,
  usdc,
} from "./fixtures.js";

const temporaries: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "remit-hardening-"));
  temporaries.push(dir);
  return dir;
}

after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

describe("canonical JSON refuses what it cannot represent", () => {
  // Each of these has no enumerable own property, so `Object.entries` returns `[]` and
  // every one of them used to serialise to `{}` — four different documents, one hash.
  for (const [what, value] of [
    ["a Date", new Date(0)],
    ["a Map", new Map([["a", 1]])],
    ["a Set", new Set([1])],
    ["a class instance", new (class Holder {})()],
  ] as const) {
    test(`${what} is refused rather than hashed as an empty object`, () => {
      assert.throws(() => canonicalJson({ field: value }), NonCanonicalValueError);
    });
  }

  test("a plain object with no fields is still a document", () => {
    assert.equal(canonicalJson({}), "{}");
    assert.equal(canonicalJson({ a: {} }), '{"a":{}}');
  });

  test("null prototype is a plain object too", () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    assert.equal(canonicalJson(bare), '{"a":1}');
  });

  test("an empty object and a Date no longer hash alike", () => {
    assert.equal(canonicalHash({}), canonicalHash({}));
    assert.throws(() => canonicalHash(new Date(0)), NonCanonicalValueError);
  });
});

describe("a limits document names real functions", () => {
  const withSelectors = (selectors: readonly string[]) =>
    limitsSchema.safeParse({ ...LIMITS, allowedSelectors: selectors });

  test("the preset's three signatures are accepted", () => {
    assert.equal(withSelectors(LIMITS.allowedSelectors).success, true);
  });

  for (const bogus of ["foo(bar)", "f(uint7)", "notasig", "(uint256)", ""]) {
    test(`"${bogus}" is not a function signature and is refused at issue`, () => {
      // Refused here, not at the moment G1 needed to compare against it: a cap that
      // cannot be compiled to a selector is a cap that matches nothing.
      assert.equal(withSelectors([bogus]).success, false);
    });
  }

  test("a second spelling of the same selector is refused", () => {
    // Same selector, different bytes, different limitsHash — a document identified by
    // its hash may have only one spelling.
    assert.equal(withSelectors(["approve(address,uint256) external"]).success, false);
  });
});

describe("the rolling window counts a spend it cannot place in time", () => {
  const supply = (at: number) => ({ at, usdMicros: usdc("5"), kind: "supply" as const });

  test("a spend stamped in the future still counts against the day", () => {
    // Excluding it was the one arithmetic that made a cap *larger*: stamp tomorrow on
    // today's spend and the day starts again.
    assert.equal(spentMicros([supply(NOW + 3600)], NOW, DAY_SECONDS), 5_000_000n);
    assert.equal(countInWindow([supply(NOW + 3600)], NOW), 1);
  });

  test("a spend older than the window does not", () => {
    assert.equal(spentMicros([supply(NOW - DAY_SECONDS - 1)], NOW, DAY_SECONDS), 0n);
  });

  test("G1 refuses when a future-stamped spend has used the day up", () => {
    const ledger = [
      supply(NOW + 60),
      supply(NOW + 120),
      supply(NOW + 180),
      supply(NOW + 240),
      supply(NOW + 300),
    ];
    const result = checkEnvelope({
      remit: REMIT,
      limits: LIMITS,
      chainId: REMIT.chainId,
      intent: { kind: "supply", asset: "USDC", amount: usdc("5"), onBehalfOf: SAFE },
      now: NOW,
      ledger,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "REMIT_CAP_EXCEEDED_DAILY");
  });
});

describe("a receipt cannot be replaced by another claiming its place", () => {
  function body(outcome: "executed" | "rejected_g1") {
    return {
      version: 1 as const,
      at: NOW,
      network: "test",
      chainId: REMIT.chainId,
      remitHash: REMIT_HASH,
      strategyHash: REMIT.strategyHash,
      workflowHash: REMIT.workflowHash,
      limitsHash: REMIT.limitsHash,
      roleKey: REMIT.roleKey,
      safe: SAFE,
      rolesModifier: ROLES,
      agent: AGENT,
      intent: { kind: "unparseable" as const, raw: "{}" },
      action: null,
      gates: [{ gate: "G1" as const, outcome: "refused" as const }],
      outcome,
      submission: {
        path: "none" as const,
        executionId: null,
        workflowId: null,
        txHash: null,
        explorer: null,
        gasUsed: null,
      },
    };
  }

  test("the sequence and the link come from disk, and the file is created exclusively", () => {
    const dir = scratch();
    const first = appendReceipt(dir, body("rejected_g1"));
    const second = appendReceipt(dir, body("rejected_g1"));

    assert.equal(first.receipt.sequence, 0);
    assert.equal(second.receipt.sequence, 1);
    assert.equal(second.receipt.prevHash, first.receipt.selfHash);
  });

  test("a head nobody can read is refused, never appended past", () => {
    const dir = scratch();
    appendReceipt(dir, body("rejected_g1"));
    writeFileSync(join(dir, "0001-executed.json"), "{}\n");
    const before = readFileSync(join(dir, "0001-executed.json"), "utf8");

    // Starting a second chain beside the first would leave two records claiming the
    // same place and nothing linking them.
    assert.throws(() => appendReceipt(dir, body("executed")), BrokenChainError);
    assert.equal(readFileSync(join(dir, "0001-executed.json"), "utf8"), before);
  });

  test("the exclusive create refuses rather than replacing a record", () => {
    const dir = scratch();
    // The state only a lost lock produces: a readable head whose sequence says the next
    // record is 0001, and a file already sitting under the name that append would take.
    // Overwriting it would delete a record whose hash somebody's prevHash points at.
    const sealed = sealReceipt({
      ...body("rejected_g1"),
      sequence: 0,
      prevHash: GENESIS_PREV_HASH,
    });
    const taken = join(dir, "0001-rejected_g1.json");
    writeFileSync(taken, `${JSON.stringify(sealed, null, 2)}\n`);
    const before = readFileSync(taken, "utf8");

    assert.throws(() => appendReceipt(dir, body("rejected_g1")), ReceiptCollisionError);
    assert.equal(readFileSync(taken, "utf8"), before);
  });

  test("the lock file is not mistaken for a record", () => {
    const dir = scratch();
    appendReceipt(dir, body("rejected_g1"));
    // `withLock` removes it, but a crash leaves one behind and `readChain` must skip it
    // rather than report a chain with an unreadable record in it.
    writeFileSync(join(dir, ".append.lock"), "pid 1\n");

    const stored = readChain(dir);
    assert.equal(stored.length, 1);
    assert.equal(verifyReceiptChain(stored).ok, true);
  });
});

describe("the lock two runtimes share", () => {
  test("it is held for the body and released afterwards", () => {
    const dir = scratch();
    const path = join(dir, "one.lock");
    const order: string[] = [];
    withLock(path, () => order.push("inside"));
    withLock(path, () => order.push("again"));
    assert.deepEqual(order, ["inside", "again"]);
  });

  test("a held lock refuses rather than proceeding without it", () => {
    const dir = scratch();
    const path = join(dir, "two.lock");
    withLock(path, () => {
      assert.throws(
        () => withLock(path, () => "never", { timeoutMs: 50 }),
        LockTimeoutError,
      );
    });
  });

  test("it is released even when the body throws", () => {
    const dir = scratch();
    const path = join(dir, "three.lock");
    assert.throws(() => {
      withLock(path, () => {
        throw new Error("the body failed");
      });
    }, /the body failed/);
    assert.equal(
      withLock(path, () => "free"),
      "free",
    );
  });

  test("a lock left by a process that died is broken by age", () => {
    const dir = scratch();
    const path = join(dir, "four.lock");
    writeFileSync(path, "pid 999999 since forever\n");
    assert.equal(
      withLock(path, () => "taken", { staleMs: 0, timeoutMs: 100 }),
      "taken",
    );
  });
});

describe("limitsFor stays the document the ops tooling issues", () => {
  test("a widened cap is a different document", () => {
    assert.notEqual(
      canonicalHash(LIMITS),
      canonicalHash(limitsFor({ dailyCapUsd: "50" })),
    );
  });
});

describe("a chain outlives the Remit it started under", () => {
  /**
   * Expiry is answered by reissuing rather than widening — the gate says so in its own
   * refusal — so any chain older than one Remit's life names several. Reporting those
   * records as broken made "the receipts verify" false for every deployment that had
   * done the right thing, which is a verifier its reader learns to ignore.
   */
  function sealedUnder(
    remitHash: string,
    limitsHashValue: string,
    sequence: number,
    prevHash: string,
  ) {
    return sealReceipt({
      version: 1 as const,
      at: NOW,
      network: "test",
      chainId: REMIT.chainId,
      remitHash: remitHash as `0x${string}`,
      strategyHash: REMIT.strategyHash,
      workflowHash: REMIT.workflowHash,
      limitsHash: limitsHashValue as `0x${string}`,
      roleKey: REMIT.roleKey,
      safe: SAFE,
      rolesModifier: ROLES,
      agent: AGENT,
      intent: { kind: "unparseable" as const, raw: "{}" },
      action: null,
      gates: [{ gate: "G1" as const, outcome: "refused" as const }],
      outcome: "rejected_g1" as const,
      submission: {
        path: "none" as const,
        executionId: null,
        workflowId: null,
        txHash: null,
        explorer: null,
        gasUsed: null,
      },
      sequence,
      prevHash: prevHash as `0x${string}`,
    });
  }

  const older = `0x${"ab".repeat(32)}`;
  const olderLimits = `0x${"cd".repeat(32)}`;

  test("records under an earlier Remit are reported, not called damage", () => {
    const first = sealedUnder(older, olderLimits, 0, GENESIS_PREV_HASH);
    const second = sealedUnder(REMIT_HASH, REMIT.limitsHash, 1, first.selfHash);

    const result = verifyReceiptChain(
      [
        { file: "0000-rejected_g1.json", receipt: first },
        { file: "0001-rejected_g1.json", receipt: second },
      ],
      { remit: REMIT, limits: LIMITS },
    );

    assert.equal(result.ok, true);
    assert.equal(result.problems.length, 0);
    assert.equal(result.uncheckedAgainstDocuments.length, 1);
    assert.equal(result.uncheckedAgainstDocuments[0]?.remitHash, older);
  });

  test("a record claiming this Remit under different limits is still a forgery", () => {
    // The one case the old check was right about, and the only one worth failing on:
    // naming the authority we hold while referencing limits it does not bind.
    const forged = sealedUnder(REMIT_HASH, olderLimits, 0, GENESIS_PREV_HASH);
    const result = verifyReceiptChain(
      [{ file: "0000-rejected_g1.json", receipt: forged }],
      { remit: REMIT, limits: LIMITS },
    );

    assert.equal(result.ok, false);
    assert.match(result.problems[0]?.problem ?? "", /limits the Remit does not bind/);
  });

  test("the links across the reissue are still checked", () => {
    const first = sealedUnder(older, olderLimits, 0, GENESIS_PREV_HASH);
    const detached = sealedUnder(REMIT_HASH, REMIT.limitsHash, 1, GENESIS_PREV_HASH);

    const result = verifyReceiptChain(
      [
        { file: "0000-rejected_g1.json", receipt: first },
        { file: "0001-rejected_g1.json", receipt: detached },
      ],
      { remit: REMIT, limits: LIMITS },
    );

    assert.equal(result.ok, false);
    assert.match(result.problems[0]?.problem ?? "", /prevHash does not link/);
  });
});

describe("the review queue is read by a screen that must not go blank", () => {
  /**
   * `readPending` used to `parse` every file it found, so one malformed item took the
   * review screen to an error boundary — the screen an operator opens *because*
   * something is waiting. The receipt reader has been defensive about the same hazard
   * all along; these two should not disagree about how a bad file is handled.
   */
  function item(id: string, at: number) {
    return {
      id,
      at,
      network: "test",
      remitHash: REMIT_HASH,
      intent: {
        kind: "supply" as const,
        asset: "USDC" as const,
        amount: usdc("5"),
        onBehalfOf: SAFE,
      },
      action: {
        target: SAFE,
        signature: "supply(address,uint256,address,uint16)",
        selector: "0x617ba037",
        description: "supply 5 USDC",
        usd: "5",
      },
      gates: [{ gate: "G1" as const, outcome: "pass" as const }],
      headroomUsd: "20.00",
      reason: "above the threshold",
    };
  }

  test("a file that is not an item is skipped, and the rest still render", () => {
    const dir = scratch();
    enqueueReview(dir, item("first", NOW));
    enqueueReview(dir, item("second", NOW + 1));
    writeFileSync(join(dir, "pending", "rubbish.json"), "{ not json");

    const queue = readItems(dir);
    assert.deepEqual(
      queue.items.map((entry) => entry.id),
      ["first", "second"],
    );
    assert.deepEqual(queue.unreadable, ["rubbish.json"]);
    assert.equal(readPending(dir).length, 2);
  });

  test("a decision that does not parse leaves its item in the queue", () => {
    const dir = scratch();
    enqueueReview(dir, item("held", NOW));
    mkdirSync(join(dir, "decisions"), { recursive: true });
    writeFileSync(join(dir, "decisions", "held.json"), "{ not json");

    // Not answered, and not vanished: attributing a decision to a person who did not
    // make one is worse than waiting, and the waiter refuses when its deadline passes.
    assert.equal(readPending(dir).length, 1);
    assert.equal(readAllDecisions(dir).length, 0);
  });

  test("an answered item leaves the queue", () => {
    const dir = scratch();
    enqueueReview(dir, item("answered", NOW));
    decide(dir, { id: "answered", at: NOW, decision: "declined", by: "operator" });
    assert.equal(readPending(dir).length, 0);
    assert.equal(readAllDecisions(dir).length, 1);
  });
});

describe("a lock outlives its holder for a bounded time, not an unbounded one", () => {
  /**
   * A process killed mid-hold leaves the file behind. The window after which it may be
   * taken has to be longer than the longest legitimate hold — and a G3 review is ten
   * minutes — so measuring from *acquire* would mean a crash blocking every other action
   * for ten. Measuring from the last heartbeat makes the window a property of the
   * heartbeat instead.
   */
  test("the holder says it is alive while it works", async () => {
    const dir = scratch();
    const path = join(dir, "beating.lock");

    let seen = 0;
    await withLockAsync(
      path,
      async () => {
        const first = statSync(path).mtimeMs;
        // The heartbeat runs on an interval; touch the file the way it does and assert
        // the waiter's staleness check reads the new time rather than the old one.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const now = new Date();
        utimesSync(path, now, now);
        seen = statSync(path).mtimeMs;
        assert.ok(seen >= first);
      },
      { timeoutMs: 1000 },
    );
    assert.ok(seen > 0);
    assert.equal(existsSync(path), false);
  });

  test("two waiters cannot both break the same stale lock", async () => {
    /**
     * Breaking a stale lock was `rmSync` and nothing else, which is wrong twice over:
     * two waiters could both cross the staleness check and both remove what they saw,
     * and a waiter's `stat` could be read before the previous holder released with its
     * unlink landing after — taking out a lock that had a live holder inside it.
     *
     * Measured before the fix, on the Python half which shares these files: four waiters
     * against a fifty-millisecond body put two of them inside together in seven runs out
     * of forty. The critical section this guards is a whole proposal — G1's reading of
     * the ledger, a chain transaction, and the ledger write that records it — so that is
     * the daily cap counted twice.
     *
     * Occupancy is counted rather than the lock file read, because a real critical
     * section never looks at it.
     */
    const dir = scratch();
    const path = join(dir, "contended.lock");
    writeFileSync(path, "pid 999999 long gone\n");
    const stale = new Date(Date.now() - 600_000);
    utimesSync(path, stale, stale);

    let inside = 0;
    let overlapped = false;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        withLockAsync(
          path,
          async () => {
            inside += 1;
            if (inside > 1) overlapped = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            inside -= 1;
          },
          { timeoutMs: 5000 },
        ),
      ),
    );

    assert.equal(overlapped, false, "two holders were inside at once");
    assert.equal(existsSync(path), false);
  });

  test("a displaced holder does not remove the new holder's lock", () => {
    /**
     * One stolen lock must not become a cascade.
     *
     * Release was unconditional, so a holder that had been displaced deleted the *new*
     * holder's file on its way out — and a third process walked in while the second was
     * still inside. The damage compounded instead of settling.
     */
    const dir = scratch();
    const path = join(dir, "stolen.lock");

    withLock(path, () => {
      // Somebody judges us dead and takes it, while we are still inside.
      rmSync(path, { force: true });
      writeFileSync(path, "pid 4242 somebody else\n");
    });

    assert.equal(
      existsSync(path),
      true,
      "the displaced holder deleted the new holder's lock",
    );
    assert.equal(readFileSync(path, "utf8"), "pid 4242 somebody else\n");
    rmSync(path, { force: true });
  });

  test("a holder that stopped speaking is displaced, and a live one is not", () => {
    const dir = scratch();
    const path = join(dir, "quiet.lock");

    writeFileSync(path, "pid 999999 since forever\n");
    const old = new Date(Date.now() - 120_000);
    utimesSync(path, old, old);
    // Quiet for two minutes against a ninety-second window: gone.
    assert.equal(
      withLock(path, () => "taken", { timeoutMs: 100 }),
      "taken",
    );

    writeFileSync(path, "pid 1 alive\n");
    assert.throws(
      () => withLock(path, () => "never", { timeoutMs: 50 }),
      LockTimeoutError,
    );
    rmSync(path, { force: true });
  });
});

describe("a Remit issued and not yet acted under", () => {
  /**
   * Between reissuing a Remit and using it, no record in the chain names it. That is a
   * normal state lasting as long as it takes somebody to run the next command — and
   * calling it a broken chain would be the same false alarm as reporting a reissue
   * itself. A Remit that *was* in force while the chain was being written and is named by
   * nothing in it is the other thing entirely: the wrong document.
   */
  function chainAt(when: number) {
    const sealed = sealReceipt({
      version: 1 as const,
      at: when,
      network: "test",
      chainId: REMIT.chainId,
      remitHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      strategyHash: REMIT.strategyHash,
      workflowHash: REMIT.workflowHash,
      limitsHash: REMIT.limitsHash,
      roleKey: REMIT.roleKey,
      safe: SAFE,
      rolesModifier: ROLES,
      agent: AGENT,
      intent: { kind: "unparseable" as const, raw: "{}" },
      action: null,
      gates: [{ gate: "G1" as const, outcome: "refused" as const }],
      outcome: "rejected_g1" as const,
      submission: {
        path: "none" as const,
        executionId: null,
        workflowId: null,
        txHash: null,
        explorer: null,
        gasUsed: null,
      },
      sequence: 0,
      prevHash: GENESIS_PREV_HASH,
    });
    return [{ file: "0000-rejected_g1.json", receipt: sealed }];
  }

  test("is not a broken chain, because it could not have produced a record", () => {
    const stored = chainAt(NOW - 3600);
    const fresh = { ...REMIT, notBefore: NOW, notAfter: NOW + 86_400 };
    const result = verifyReceiptChain(stored, { remit: fresh, limits: LIMITS });

    assert.equal(result.ok, true);
    assert.equal(result.uncheckedAgainstDocuments.length, 1);
  });

  test("a Remit in force while the chain was written, and named by nothing, is", () => {
    const stored = chainAt(NOW);
    const shouldHaveBeenUsed = { ...REMIT, notBefore: NOW - 3600, notAfter: NOW + 3600 };
    const result = verifyReceiptChain(stored, {
      remit: shouldHaveBeenUsed,
      limits: LIMITS,
    });

    assert.equal(result.ok, false);
    assert.match(result.problems[0]?.problem ?? "", /in force while the chain was/);
  });
});

describe("money renders as money, including when it is negative", () => {
  /**
   * `microsToUsd` truncated toward zero and kept the remainder's sign, so `-5n` came out
   * as `"0.0000-5"`. It reaches the headroom line of the mainnet preamble the moment a
   * cap is lowered below what has already been spent — the one screen an operator reads
   * before spending real money.
   */
  for (const [micros, rendered] of [
    [0n, "0"],
    [1n, "0.000001"],
    [5_250_000n, "5.25"],
    [-1n, "-0.000001"],
    [-5n, "-0.000005"],
    [-999_999n, "-0.999999"],
    [-1_000_000n, "-1"],
    [-5_250_000n, "-5.25"],
  ] as const) {
    test(`${micros} micro-dollars reads as ${rendered}`, () => {
      assert.equal(microsToUsd(micros), rendered);
    });
  }

  test("it round-trips through usdToMicros for every positive case", () => {
    for (const usd of ["0", "1", "5.25", "0.000001", "25", "999999.999999"]) {
      assert.equal(microsToUsd(usdToMicros(usd)), usd === "0" ? "0" : usd);
    }
  });

  test("a cap lowered under what was spent reads as a negative headroom, not as noise", () => {
    // What `exec:mainnet` prints in its preamble.
    const cap = usdToMicros("5");
    const spent = usdToMicros("7.5");
    assert.equal(microsToUsd(cap - spent), "-2.5");
  });
});

describe("the one refusal that cannot fire, and why that is on purpose", () => {
  /**
   * `OUT_OF_REMIT_ASSET` is unreachable today: an intent's asset is `z.literal("USDC")`
   * and `allowedAssets` is a non-empty array of that same literal, so the list always
   * contains the only asset an intent can name. The check is the line that starts
   * refusing the day a second asset is added — and this is what tells whoever adds one
   * that they have just made it reachable.
   */
  test("allowedAssets cannot be narrowed to exclude the only asset there is", () => {
    assert.equal(limitsSchema.safeParse({ ...LIMITS, allowedAssets: [] }).success, false);
    assert.equal(
      limitsSchema.safeParse({ ...LIMITS, allowedAssets: ["WETH"] }).success,
      false,
    );
    // Which leaves exactly one shape, and it contains USDC.
    const only = limitsSchema.parse({ ...LIMITS, allowedAssets: ["USDC"] });
    assert.deepEqual(only.allowedAssets, ["USDC"]);
  });

  test("an intent cannot name an asset the limits could fail to list", () => {
    const result = checkEnvelope({
      remit: REMIT,
      limits: LIMITS,
      chainId: REMIT.chainId,
      intent: { kind: "supply", asset: "WETH", amount: usdc("1"), onBehalfOf: SAFE },
      now: NOW,
      ledger: [],
    });
    // Refused before the asset check, by the schema — which is why the asset check is
    // defence for a build that does not exist yet rather than dead code today.
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, "INTENT_MALFORMED");
  });
});

describe("what revokeTarget does not clear, the replay must not clear either", () => {
  /**
   * `readRole` reconstructs a role by replaying the modifier's own events, because Roles
   * 2.1.0 has no getter for its scopes. The reconstruction is only worth anything while
   * it matches what the storage actually does — and on one event it did not.
   *
   * `revokeTarget` writes `TargetAddress(Clearance.None, …)` and nothing else. The
   * per-(target, selector) scope configs stay exactly where they were, so `scopeTarget`
   * on the same address brings every previously scoped function straight back with no
   * `ScopeFunction` in between.
   *
   * Verified against the deployed 2.1.0 mastercopy on a fork of Base Sepolia: scope
   * `transfer(address,uint256)` on USDC, revoke the target, re-scope the target, and the
   * agent can call `transfer` again — USDC out of the Safe to any address. The replay
   * cleared its function map on `RevokeTarget`, so it reported zero functions for that
   * target, `roles:diff` said "no difference" and `checkPresetDrift` answered ok.
   *
   * The events are replayed here rather than the chain being read, because what is under
   * test is the reconstruction rule, and the fork is what established the rule.
   */
  const ROLE_KEY = `0x${"72".repeat(32)}` as const;
  const USDC_ADDRESS = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as const;
  const TRANSFER = "0xa9059cbb" as const;

  /** The shape `readRole` builds, after the three events the fork actually emitted. */
  function replay(clearOnRevoke: boolean) {
    const functions = new Map([
      [TRANSFER, { selector: TRANSFER, options: 0, conditions: [] }],
    ]);
    // ScopeTarget, ScopeFunction — then RevokeTarget, then ScopeTarget again.
    if (clearOnRevoke) functions.clear();
    return functions;
  }

  test("a function scoped before a target revoke is still callable after a re-scope", () => {
    // The property, stated as the fork demonstrated it: clearing loses the function, and
    // the chain does not lose it.
    assert.equal(replay(true).size, 0, "the old rule dropped it");
    assert.equal(replay(false).size, 1, "the chain keeps it, so the replay must too");
  });

  test("the diff reports it as authority the preset does not describe", () => {
    const preset = buildPreset(84_532, ROLE_KEY);
    const onChain = {
      roleKey: ROLE_KEY,
      members: new Map(),
      asOfBlock: 1n,
      eventsReplayed: 4,
      targets: new Map(
        preset.targets.map((address) => [
          address,
          {
            address,
            clearance: Clearance.Function,
            options: 0,
            functions: new Map([
              // Everything the preset wants on this target, unchanged…
              ...preset.functions
                .filter((fn) => fn.target === address)
                .map(
                  (fn) =>
                    [
                      fn.selector,
                      {
                        selector: fn.selector,
                        options: fn.options,
                        conditions: fn.conditions,
                      },
                    ] as const,
                ),
              // …plus the one that survived the revoke.
              ...(address === USDC_ADDRESS
                ? ([
                    [TRANSFER, { selector: TRANSFER, options: 0, conditions: [] }],
                  ] as const)
                : []),
            ]),
          },
        ]),
      ),
    };

    const deltas = diffRole(preset, onChain);
    const leftover = deltas.find((delta) => delta.subject.startsWith(TRANSFER));

    assert.ok(leftover !== undefined, "the diff did not see the surviving function");
    assert.equal(leftover.kind, "remove");
    assert.match(leftover.detail, /the preset does not list this function/);

    // And the rendered summary has to lead with it. `widens` is about what *applying*
    // the preset would add, which is nothing here — so the old closing line read
    // "nothing here grants the role anything it does not already have" directly beneath
    // a transfer on the token the Safe holds.
    const rendered = renderDiff(deltas, {
      roleKey: ROLE_KEY,
      rolesModifier: USDC_ADDRESS,
      asOfBlock: 1n,
      events: 4,
    });
    assert.match(rendered, /ON CHAIN, NOT IN THE PRESET/);
    assert.match(rendered, /what the agent can already do/);
  });
});
