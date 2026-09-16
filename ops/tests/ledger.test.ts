/**
 * The two ops-side rules that decide how much authority is left: the spend ledger, and
 * the limits document an operator's flags produce.
 *
 * Both are places where a mistake fails *open* rather than loudly — an unreadable ledger
 * that reads as "nothing spent today", a cap that is not a number and is only discovered
 * at the moment something is compared against it. So both are tested for the refusal.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spentMicros } from "@remit/core";
import { appendLedger, readLedger } from "../src/lib/ledger-store.js";
import { buildLimits, DEMO_CAPS, widenings } from "../src/remit/limits.js";
import { SAFE } from "./fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = join(HERE, "..", "deployments");
/** A network name no real deployment uses, so a test never touches a real ledger. */
const NETWORK = "anvil" as const;
const LEDGER = join(DEPLOYMENTS, `${NETWORK}.ledger.json`);

/**
 * The store resolves its own path from the module's location and reads the file fresh
 * every call, so a test drives it by writing that file — which is also exactly how an
 * operator, or a corruption, would.
 *
 * That is why `ops` runs its test files with `--test-concurrency=1`. The ledger's location is
 * fixed on purpose: `ledger-store.ts` and `remit_bridge/ledger.py` must read and write
 * the same bytes, or the daily cap counts two histories depending on which door an action
 * came through. So this file mutates the real `ops/deployments/anvil.ledger.json`, and
 * `gates.test.ts` reads it through `runPipeline` on the same network — in parallel, on a
 * loaded machine, one sees the other's write and G1 refuses a proposal the test expects
 * to pass. Seen once, and not reproduced in twenty-six runs afterwards, which is the
 * worst shape a test failure can have.
 *
 * Serialising the files is the fix rather than pointing the store somewhere else: an
 * override would be a second place the ledger can live, and one ledger is the property
 * the whole thing rests on.
 */
async function withLedger<T>(contents: string | undefined, run: () => T): Promise<T> {
  const { existsSync, readFileSync } = await import("node:fs");
  const had = existsSync(LEDGER);
  const previous = had ? readFileSync(LEDGER, "utf8") : undefined;
  mkdirSync(DEPLOYMENTS, { recursive: true });

  try {
    if (contents === undefined) rmSync(LEDGER, { force: true });
    else writeFileSync(LEDGER, contents);
    return run();
  } finally {
    if (previous === undefined) rmSync(LEDGER, { force: true });
    else writeFileSync(LEDGER, previous);
  }
}

describe("the spend ledger", () => {
  after(() => rmSync(LEDGER, { force: true }));

  test("a file that is not there is a ledger with nothing in it", async () => {
    assert.deepEqual(await withLedger(undefined, () => readLedger(NETWORK)), []);
  });

  test("a file that is not JSON is refused, not treated as empty", async () => {
    // The fail-open this exists to prevent: truncate the ledger, get the whole daily cap
    // back.
    await withLedger('[{"at":1,', () => {
      assert.throws(() => readLedger(NETWORK), /refusing to treat an unreadable/);
    });
  });

  test("a file that is JSON but not a ledger is refused", async () => {
    await withLedger('{"spent":"lots"}', () => {
      assert.throws(() => readLedger(NETWORK), /not a ledger/);
    });
    await withLedger('[{"at":"yesterday","usdMicros":"1","kind":"supply"}]', () => {
      assert.throws(() => readLedger(NETWORK), /not a ledger entry/);
    });
    await withLedger('[{"at":1,"usdMicros":"1","kind":"transfer"}]', () => {
      assert.throws(() => readLedger(NETWORK), /not a ledger entry/);
    });
  });

  test("what it stores is what the gate counts", async () => {
    const entries = await withLedger("[]", () => {
      appendLedger(NETWORK, { at: 1_800_000_000, usdMicros: "5000000", kind: "supply" });
      appendLedger(NETWORK, { at: 1_800_000_001, usdMicros: "2000000", kind: "supply" });
      return readLedger(NETWORK);
    });
    assert.equal(entries.length, 2);
    assert.equal(spentMicros(entries, 1_800_000_002), 7_000_000n);
  });

  test("an entry that is not an entry is never written", async () => {
    await withLedger("[]", () => {
      assert.throws(() =>
        appendLedger(NETWORK, { at: 1_800_000_000, usdMicros: "-1", kind: "supply" }),
      );
      assert.deepEqual(readLedger(NETWORK), []);
    });
  });
});

describe("the limits an operator's flags produce", () => {
  test("default to the caps in CLAUDE.md §2.4", () => {
    const limits = buildLimits(84_532, SAFE);
    assert.equal(limits.perTxCapUsd, DEMO_CAPS.perTxCapUsd);
    assert.equal(limits.dailyCapUsd, DEMO_CAPS.dailyCapUsd);
    assert.deepEqual(limits.allowedRecipients, [SAFE]);
  });

  test("name the Safe as the only recipient — the line that makes exfiltration unrepresentable", () => {
    const limits = buildLimits(84_532, SAFE);
    assert.equal(limits.allowedRecipients.length, 1);
    assert.equal(limits.allowedRecipients[0], SAFE);
  });

  test("refuse a cap that is not a USD amount, at issue rather than at use", () => {
    // Caught here, before the document is hashed into a Remit and signed — rather than
    // at the moment G1 first tries to compare an amount against "abc".
    for (const cap of ["abc", "1e6", "5,00", "-5", ""]) {
      assert.throws(
        () => buildLimits(84_532, SAFE, { perTxCapUsd: cap }),
        /not a valid limits document/,
        cap,
      );
    }
  });
});

/**
 * A Remit that permits more than the one it replaces.
 *
 * `roles:apply` will not widen the on-chain preset without `--yes`, on any network.
 * Reissuing a Remit had no such ceremony — and the preset leaves `amount` as `Pass`, so
 * the caps that actually bound the money live in the Remit rather than on chain.
 * Doubling the daily cap was a quieter act than re-scoping a function that changes
 * nothing about how much can move.
 */
describe("a reissued Remit that permits more says so", () => {
  const base = buildLimits(84_532, SAFE);

  test("narrowing is silent — that is what fixing a mistake looks like", () => {
    const tighter = buildLimits(84_532, SAFE, { perTxCapUsd: "1", dailyCapUsd: "2" });
    assert.deepEqual(widenings(base, tighter), []);
    assert.deepEqual(widenings(base, base), []);
  });

  test("a larger per-transaction cap is named", () => {
    const wider = buildLimits(84_532, SAFE, { perTxCapUsd: "50" });
    const lines = widenings(base, wider);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /perTxCapUsd 5 → 50 USD/);
  });

  test("a larger day is named", () => {
    const wider = buildLimits(84_532, SAFE, { dailyCapUsd: "1000" });
    assert.match(widenings(base, wider)[0] ?? "", /dailyCapUsd 25 → 1000 USD/);
  });

  test("raising the review threshold is a widening of a different kind", () => {
    // The same money moves; fewer people look at it. A cap comparison alone would call
    // this document identical to its ancestor.
    const wider = buildLimits(84_532, SAFE, { requireReviewAboveUsd: "5" });
    assert.match(widenings(base, wider)[0] ?? "", /fewer actions stop for a person/);
  });

  test("acting faster is a widening", () => {
    const wider = buildLimits(84_532, SAFE, { maxTxPerHour: 600 });
    assert.match(widenings(base, wider)[0] ?? "", /the agent may act faster/);
  });

  test("a new recipient is the one that matters most", () => {
    // `allowedRecipients: [the Safe]` is the line the README calls the whole talk. A
    // second entry is where value may now land, and it is a set change rather than a
    // number, so no cap comparison would have seen it.
    const attacker = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    const wider = { ...base, allowedRecipients: [...base.allowedRecipients, attacker] };
    const lines = widenings(base, wider as typeof base);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /allowedRecipients gains 0x9965/);
  });

  test("a new selector, target, kind or asset is named too", () => {
    const wider = {
      ...base,
      allowedSelectors: [...base.allowedSelectors, "transfer(address,uint256)"],
      allowedIntentKinds: base.allowedIntentKinds,
    };
    assert.match(
      widenings(base, wider as typeof base)[0] ?? "",
      /allowedSelectors gains/,
    );
  });
});
