/**
 * The serialiser every hash in the system goes through.
 *
 * Two people hashing the same document on two machines must get the same bytes, or the
 * receipt chain proves nothing (PRD.md RM-3). Everything here is a property of that
 * sentence rather than of the implementation.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  canonicalHash,
  canonicalJson,
  NonCanonicalValueError,
} from "../src/canonical/json.js";

describe("canonicalJson", () => {
  test("key order does not change the bytes", () => {
    const one = { alpha: 1, beta: [2, 3], gamma: { delta: true } };
    const other = { gamma: { delta: true }, beta: [2, 3], alpha: 1 };
    assert.equal(canonicalJson(one), canonicalJson(other));
    assert.equal(canonicalJson(one), '{"alpha":1,"beta":[2,3],"gamma":{"delta":true}}');
  });

  test("array order does change the bytes", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test("an unset optional field and a missing one are the same document", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  });

  test("nesting is sorted all the way down", () => {
    assert.equal(
      canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } }),
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  test("a float is refused rather than rounded", () => {
    assert.throws(() => canonicalJson({ amount: 5.5 }), NonCanonicalValueError);
  });

  test("a bigint is refused — amounts are decimal strings", () => {
    assert.throws(() => canonicalJson({ amount: 5n }), NonCanonicalValueError);
  });

  test("an integer beyond 2^53 is refused", () => {
    assert.throws(() => canonicalJson({ amount: 2 ** 53 }), NonCanonicalValueError);
  });

  test("NaN and Infinity are refused", () => {
    assert.throws(() => canonicalJson({ a: Number.NaN }), NonCanonicalValueError);
    assert.throws(
      () => canonicalJson({ a: Number.POSITIVE_INFINITY }),
      NonCanonicalValueError,
    );
  });

  test("undefined inside an array is refused rather than becoming null", () => {
    assert.throws(() => canonicalJson([1, undefined, 3]), NonCanonicalValueError);
  });

  test("the error names the path that failed", () => {
    try {
      canonicalJson({ limits: { caps: [1, 2.5] } });
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof NonCanonicalValueError);
      assert.equal(error.path, "$.limits.caps[1]");
    }
  });

  test("strings are JSON-escaped, so a quote cannot forge a document", () => {
    assert.equal(canonicalJson({ a: '"},"b":"' }), '{"a":"\\"},\\"b\\":\\""}');
  });

  test("unicode survives the round trip", () => {
    const value = { note: "üç — ⛓" };
    assert.deepEqual(JSON.parse(canonicalJson(value)), value);
  });
});

describe("canonicalHash", () => {
  test("is keccak256 over those bytes — a fixed vector", () => {
    // Pinned deliberately. Every `…Hash` in every committed receipt is this function; if
    // this value ever changes, so has every hash the project has ever published, and the
    // change needs to be a decision rather than a surprise.
    assert.equal(
      canonicalHash({ b: 2, a: 1 }),
      "0xb8ffb64722137f4b100665a52e3c943f8066e8ab8ba3b427e6f4b404defd82b0",
    );
  });

  test("differs for documents that differ", () => {
    assert.notEqual(canonicalHash({ cap: "5" }), canonicalHash({ cap: "6" }));
  });

  test("is insensitive to key order", () => {
    assert.equal(canonicalHash({ x: 1, y: 2 }), canonicalHash({ y: 2, x: 1 }));
  });
});
