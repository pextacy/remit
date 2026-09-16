/**
 * G3 — the queue, and the two properties that make it a gate rather than a form.
 *
 * A decision cannot be changed once made, and an id cannot become a path. The second one
 * matters more than it looks: the id arrives from a form field in the console, and the
 * store turns it into a filename in two directories.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import {
  decide,
  enqueueReview,
  type ReviewItem,
  readAllDecisions,
  readDecision,
  readPending,
  reviewIdSchema,
} from "../src/review/index.js";
import { NOW, POOL, REMIT_HASH, SAFE, usdc } from "./fixtures.js";

const temporaries: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "remit-review-"));
  temporaries.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const ID = "8e1f2c30-0000-4000-8000-000000000000";

function item(id = ID, at = NOW): ReviewItem {
  return {
    id,
    at,
    network: "anvil",
    remitHash: REMIT_HASH,
    intent: { kind: "supply", asset: "USDC", amount: usdc("5"), onBehalfOf: SAFE },
    action: {
      target: POOL,
      signature: "supply(address,uint256,address,uint16)",
      selector: "0x617ba037",
      description: "supply 5000000 USDC to Aave, credited to the Safe",
      usd: "5",
    },
    gates: [
      { gate: "G1", outcome: "pass" },
      { gate: "G2", outcome: "pass", detail: "preflight clean, no gas spent" },
    ],
    headroomUsd: "20.00",
    reason: "above the Remit's review threshold of 1 USD",
  };
}

describe("the queue", () => {
  let dir = "";
  beforeEach(() => {
    dir = scratch();
  });

  test("an item waits until it is decided", () => {
    enqueueReview(dir, item());
    assert.equal(readPending(dir).length, 1);
    decide(dir, { id: ID, at: NOW, decision: "approved", by: "operator" });
    assert.equal(readPending(dir).length, 0);
  });

  test("pending items come back oldest first", () => {
    enqueueReview(dir, item("bbb", NOW + 100));
    enqueueReview(dir, item("aaa", NOW));
    assert.deepEqual(
      readPending(dir).map((entry) => entry.id),
      ["aaa", "bbb"],
    );
  });

  test("the first answer wins — a decision nobody can change is one somebody owns", () => {
    enqueueReview(dir, item());
    decide(dir, { id: ID, at: NOW, decision: "declined", by: "operator" });
    const second = decide(dir, {
      id: ID,
      at: NOW + 5,
      decision: "approved",
      by: "someone else",
    });
    assert.equal(second.decision, "declined");
    assert.equal(readDecision(dir, ID)?.by, "operator");
  });

  test("a queue with nothing in it is not an error", () => {
    assert.deepEqual(readPending(dir), []);
    assert.deepEqual(readAllDecisions(dir), []);
    assert.equal(readDecision(dir, ID), undefined);
  });

  test("the reviewer is shown named parameters, never raw calldata", () => {
    enqueueReview(dir, item());
    const [pending] = readPending(dir);
    assert.ok(pending);
    assert.doesNotMatch(JSON.stringify(pending), /"calldata"/);
    assert.match(pending.action.description, /supply/);
  });
});

describe("an id cannot become a path", () => {
  let dir = "";
  beforeEach(() => {
    dir = scratch();
  });

  test("a traversal is refused, and writes nothing", () => {
    const traversal = "../../../../../../tmp/remit-pwned";
    assert.throws(() =>
      decide(dir, { id: traversal, at: NOW, decision: "approved", by: "attacker" }),
    );
    assert.equal(existsSync("/tmp/remit-pwned.json"), false);
    assert.equal(readdirSync(dir).length <= 1, true);
  });

  test("a separator in any form is refused", () => {
    for (const id of ["a/b", "a\\b", "..", ".", "/etc/passwd", "a/../b", ""]) {
      assert.equal(reviewIdSchema.safeParse(id).success, false, id);
    }
  });

  test("reading with a bad id answers 'no decision' rather than reaching for a file", () => {
    assert.equal(readDecision(dir, "../../etc/passwd"), undefined);
  });

  test("a uuid — what actually produces these — is fine", () => {
    assert.equal(reviewIdSchema.safeParse(ID).success, true);
    assert.equal(reviewIdSchema.safeParse(crypto.randomUUID()).success, true);
  });

  test("an item cannot be queued under one either", () => {
    assert.throws(() => enqueueReview(dir, item("../escape")));
  });
});
