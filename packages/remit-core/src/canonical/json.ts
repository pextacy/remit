/**
 * Canonical JSON: sorted keys, no whitespace, one byte sequence per document.
 *
 * Two people hashing the same Remit on two machines must get the same digest, or the
 * provenance chain proves nothing (PRD.md RM-3, RC-3). `JSON.stringify` does not promise
 * that — key order follows insertion — so serialisation is done here, once, and every
 * hash in the system goes through it.
 *
 * Deliberately narrow about what it will serialise. A `number` that is not an integer, a
 * `bigint`, a `Date`, `undefined` inside an array: all rejected rather than coerced,
 * because every one of those is a silently different document on the other machine.
 * Amounts are decimal strings everywhere in this codebase for the same reason.
 */
import { type Hex, keccak256, toBytes } from "viem";

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class NonCanonicalValueError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`value at ${path} cannot be canonicalised: ${detail}`);
    this.name = "NonCanonicalValueError";
  }
}

function serialise(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new NonCanonicalValueError(path, "not a finite number");
      }
      if (!Number.isSafeInteger(value)) {
        // A float's shortest round-trip representation is not stable across runtimes,
        // and 2^53 is not a theoretical limit for token amounts. Use a decimal string.
        throw new NonCanonicalValueError(
          path,
          "not a safe integer — use a decimal string",
        );
      }
      return String(value);
    case "bigint":
      throw new NonCanonicalValueError(path, "bigint — use a decimal string");
    case "undefined":
      throw new NonCanonicalValueError(path, "undefined");
    case "object":
      break;
    default:
      throw new NonCanonicalValueError(path, `unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialise(item, `${path}[${index}]`)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absence, not a value: an optional field that was never set must
    // produce the same bytes as one that is missing entirely.
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${serialise(item, `${path}.${key}`)}`)
    .join(",");

  return `{${body}}`;
}

/** The one serialisation. Sorted keys, no whitespace, recursively. */
export function canonicalJson(value: unknown): string {
  return serialise(value, "$");
}

/** keccak256 over the canonical bytes. Every `…Hash` field in the system is this. */
export function canonicalHash(value: unknown): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}
