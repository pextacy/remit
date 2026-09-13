/**
 * Turn a revert into a name.
 *
 * G2 exists to tell an operator *why* the Roles Modifier would refuse a call, before any
 * gas is spent. A bare `0x…` blob does not do that, so an undecoded revert is a failed
 * requirement rather than an acceptable output (PRD.md G2-2, CLAUDE.md §8). This module
 * is the one place that knows how.
 *
 * It decodes against the ABI of the mastercopy actually deployed — `rolesAbi`, Roles
 * 2.1.0 — and resolves `ConditionViolation(uint8,bytes32)` through the `Status` enum from
 * the same version, so the caller gets `TargetAddressNotAllowed`, not `2`.
 */
import { decodeErrorResult, type Hex } from "viem";
import { rolesAbi } from "./abi/roles.js";
import { safeAbi } from "./abi/safe.js";
import { ROLES_STATUS, ROLES_STATUS_REASON, type RolesStatus } from "./roles-status.js";

/** Selector of `Error(string)` — Solidity's `require`/`revert "…"`. */
const ERROR_STRING_SELECTOR = "0x08c379a0";
/** Selector of `Panic(uint256)` — Solidity's assertion failures. */
const PANIC_SELECTOR = "0x4e487b71";

export type DecodedRevert =
  | {
      readonly kind: "roles_condition_violation";
      /** The `Status` ordinal the modifier returned. */
      readonly status: number;
      /** Its name in Roles 2.1.0, e.g. `ParameterNotAllowed`. */
      readonly statusName: RolesStatus;
      /** The natspec sentence for that status. */
      readonly reason: string;
      /**
       * Whatever the modifier attached. For a parameter violation this is the condition
       * node's key, which is how a preset author finds the offending line.
       */
      readonly info: Hex;
      readonly data: Hex;
    }
  | {
      readonly kind: "roles_error";
      readonly name: string;
      readonly args: readonly unknown[];
      readonly data: Hex;
    }
  | {
      readonly kind: "safe_error";
      readonly name: string;
      readonly args: readonly unknown[];
      readonly data: Hex;
    }
  | {
      /** Solidity `Error(string)`. Safe 1.4.1 reverts this way: "GS013", "GS026", … */
      readonly kind: "revert_string";
      readonly reason: string;
      readonly data: Hex;
    }
  | { readonly kind: "panic"; readonly code: bigint; readonly data: Hex }
  | { readonly kind: "empty"; readonly data: Hex }
  | {
      /**
       * Nothing in our ABIs matches. Not an acceptable end state for G2 — it means the
       * deployment drifted from the ABI we pinned, and that is worth failing loudly over.
       */
      readonly kind: "undecodable";
      readonly data: Hex;
    };

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
}

/**
 * Pull the revert data out of whatever viem, an RPC error, or a nested cause is holding.
 * Providers disagree about where they put it, so look in every place they use.
 */
export function extractRevertData(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);

    if (isHex(current)) return current;
    if (typeof current !== "object") continue;

    const record = current as Record<string, unknown>;
    for (const key of ["data", "raw", "returnData", "output", "value"]) {
      const candidate = record[key];
      if (isHex(candidate)) return candidate;
      if (candidate !== undefined) queue.push(candidate);
    }
    for (const key of ["cause", "error", "details", "info", "walk"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }

  return undefined;
}

/** Decode raw revert data. Never throws: an unknown blob comes back as `undecodable`. */
export function decodeRevertData(data: Hex): DecodedRevert {
  if (data === "0x" || data.length <= 2) return { kind: "empty", data };

  const selector = data.slice(0, 10).toLowerCase();

  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const decoded = decodeErrorResult({
        abi: [
          {
            type: "error",
            name: "Error",
            inputs: [{ name: "reason", type: "string" }],
          },
        ] as const,
        data,
      });
      return { kind: "revert_string", reason: String(decoded.args?.[0] ?? ""), data };
    } catch {
      return { kind: "undecodable", data };
    }
  }

  if (selector === PANIC_SELECTOR) {
    try {
      const decoded = decodeErrorResult({
        abi: [
          { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
        ] as const,
        data,
      });
      return { kind: "panic", code: BigInt(String(decoded.args?.[0] ?? 0)), data };
    } catch {
      return { kind: "undecodable", data };
    }
  }

  try {
    const decoded = decodeErrorResult({ abi: rolesAbi, data });
    const args = (decoded.args ?? []) as readonly unknown[];

    if (decoded.errorName === "ConditionViolation") {
      const status = Number(args[0]);
      const statusName = ROLES_STATUS[status];
      if (statusName !== undefined) {
        return {
          kind: "roles_condition_violation",
          status,
          statusName,
          reason: ROLES_STATUS_REASON[statusName],
          info: (args[1] as Hex) ?? "0x",
          data,
        };
      }
      // A status the deployed enum does not have means the modifier is not the version
      // we pinned. Say so rather than inventing a name for it.
      return { kind: "roles_error", name: "ConditionViolation", args, data };
    }

    return { kind: "roles_error", name: decoded.errorName, args, data };
  } catch {
    // fall through to the Safe ABI
  }

  try {
    const decoded = decodeErrorResult({ abi: safeAbi, data });
    return {
      kind: "safe_error",
      name: decoded.errorName,
      args: (decoded.args ?? []) as readonly unknown[],
      data,
    };
  } catch {
    return { kind: "undecodable", data };
  }
}

/** Decode whatever a call threw. */
export function decodeRevert(error: unknown): DecodedRevert {
  const data = extractRevertData(error);
  return data === undefined
    ? { kind: "undecodable", data: "0x" }
    : decodeRevertData(data);
}

/** One line an operator can read. This is what goes in a receipt and on the console. */
export function formatRevert(decoded: DecodedRevert): string {
  switch (decoded.kind) {
    case "roles_condition_violation":
      return `ConditionViolation: ${decoded.statusName} (${decoded.reason}) [info=${decoded.info}]`;
    case "roles_error":
      return decoded.args.length > 0
        ? `Roles.${decoded.name}(${decoded.args.map(String).join(", ")})`
        : `Roles.${decoded.name}()`;
    case "safe_error":
      return decoded.args.length > 0
        ? `Safe.${decoded.name}(${decoded.args.map(String).join(", ")})`
        : `Safe.${decoded.name}()`;
    case "revert_string":
      return `revert "${decoded.reason}"`;
    case "panic":
      return `Panic(0x${decoded.code.toString(16)})`;
    case "empty":
      return "reverted with no data";
    case "undecodable":
      return `undecodable revert ${decoded.data}`;
  }
}

/** True when the revert carries no name — the outcome G2 is not allowed to report. */
export function isUndecodable(decoded: DecodedRevert): boolean {
  return decoded.kind === "undecodable" || decoded.kind === "empty";
}
