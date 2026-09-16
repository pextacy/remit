/**
 * The permission delta: what is on chain, what the preset says, and every difference.
 *
 * `roles:diff` before `roles:apply` is not a convention, it is the control (PRD.md §9).
 * A preset is a grant of authority over real money, and the only thing standing between a
 * transcription error and an agent that can move funds somewhere unintended is a person
 * reading this output and recognising it.
 *
 * So the output is written for that person, not for a machine: every line says what the
 * role can do, in the same words the preset uses, and a widening is called a widening.
 */

import { type Address, getAddress, type Hex } from "viem";
import { canonicalJson } from "../canonical/json.js";
import {
  Clearance,
  type ConditionFlat,
  ExecutionOptions,
  Operator,
} from "../chain/roles-enums.js";
import type { OnChainFunction, OnChainRole } from "./onchain.js";
import type { Preset, ScopedFunction } from "./preset.js";

export type DeltaKind =
  /** On chain but not in the preset: authority the agent has and should not. */
  | "remove"
  /** In the preset but not on chain: authority the preset intends to grant. */
  | "add"
  /** In both, differently. */
  | "change";

export type Delta = {
  readonly kind: DeltaKind;
  readonly subject: string;
  readonly detail: string;
  /**
   * True when applying the preset would give the role *more* than it has today. A widening
   * is the thing to look twice at; a narrowing is what fixing a mistake looks like.
   */
  readonly widens: boolean;
};

const CLEARANCE_NAMES = ["None", "Target", "Function"] as const;
const OPTION_NAMES = ["None", "Send", "DelegateCall", "Both"] as const;

function clearanceName(value: number): string {
  return CLEARANCE_NAMES[value] ?? `unknown(${value})`;
}

function optionName(value: number): string {
  return OPTION_NAMES[value] ?? `unknown(${value})`;
}

function operatorName(value: number): string {
  const found = Object.entries(Operator).find(([, ordinal]) => ordinal === value);
  return found?.[0] ?? `operator(${value})`;
}

/** One condition as a line a person reads, rather than a tuple they decode. */
export function describeCondition(condition: ConditionFlat, index: number): string {
  const operator = operatorName(condition.operator);
  const value =
    condition.compValue === "0x"
      ? ""
      : ` ${condition.compValue.length === 66 ? `0x…${condition.compValue.slice(-8)}` : condition.compValue}`;
  return `[${index}] parent=${condition.parent} ${operator}${value}`;
}

function conditionsEqual(
  left: readonly ConditionFlat[] | undefined,
  right: readonly ConditionFlat[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function presetFunctionsFor(preset: Preset, target: Address): readonly ScopedFunction[] {
  return preset.functions.filter((fn) => getAddress(fn.target) === getAddress(target));
}

export function diffRole(preset: Preset, onChain: OnChainRole): readonly Delta[] {
  const deltas: Delta[] = [];
  const presetTargets = new Set(preset.targets.map((target) => getAddress(target)));
  const chainTargets = new Map(
    [...onChain.targets.entries()].filter(
      ([, target]) => target.clearance !== Clearance.None,
    ),
  );

  // ---- targets the chain has and the preset does not -----------------------
  for (const [address, target] of chainTargets) {
    if (presetTargets.has(address)) continue;
    deltas.push({
      kind: "remove",
      subject: `target ${address}`,
      detail:
        `on chain with clearance ${clearanceName(target.clearance)}, ` +
        `${target.functions.size} function(s) — the preset does not list it`,
      widens: false,
    });
  }

  for (const address of presetTargets) {
    const chainTarget = chainTargets.get(address);
    const wanted = presetFunctionsFor(preset, address);

    if (chainTarget === undefined) {
      deltas.push({
        kind: "add",
        subject: `target ${address}`,
        detail: `not cleared on chain — the preset scopes ${wanted.length} function(s) on it`,
        widens: true,
      });
      continue;
    }

    // A target at `Clearance.Target` is *every* function on that contract. The preset
    // always wants `Function`, so this is the single most important line in the diff.
    if (chainTarget.clearance !== Clearance.Function) {
      deltas.push({
        kind: "change",
        subject: `target ${address}`,
        detail:
          `on chain at clearance ${clearanceName(chainTarget.clearance)} ` +
          `(every function, options ${optionName(chainTarget.options)}); ` +
          "the preset scopes individual functions",
        widens: false,
      });
    }

    const chainFunctions = new Map(chainTarget.functions);

    for (const fn of wanted) {
      const onChainFn = chainFunctions.get(fn.selector);
      chainFunctions.delete(fn.selector);

      if (onChainFn === undefined) {
        deltas.push({
          kind: "add",
          subject: `${fn.signature} on ${address}`,
          detail: `${fn.label} — not scoped on chain`,
          widens: true,
        });
        continue;
      }

      if (onChainFn.conditions === undefined) {
        deltas.push({
          kind: "change",
          subject: `${fn.signature} on ${address}`,
          detail:
            "on chain it is allowed with NO parameter conditions — any arguments pass; " +
            `the preset constrains ${fn.conditions.length} node(s)`,
          widens: false,
        });
      } else if (!conditionsEqual(onChainFn.conditions, fn.conditions)) {
        deltas.push({
          kind: "change",
          subject: `${fn.signature} on ${address}`,
          detail: describeConditionChange(onChainFn, fn),
          widens: false,
        });
      }

      if (onChainFn.options !== fn.options) {
        deltas.push({
          kind: "change",
          subject: `${fn.signature} on ${address}`,
          detail: `execution options ${optionName(onChainFn.options)} on chain, preset wants ${optionName(fn.options)}`,
          widens: fn.options !== ExecutionOptions.None,
        });
      }
    }

    for (const [selector, leftover] of chainFunctions) {
      deltas.push({
        kind: "remove",
        subject: `${selector} on ${address}`,
        detail:
          `scoped on chain with ${leftover.conditions?.length ?? 0} condition node(s) — ` +
          "the preset does not list this function",
        widens: false,
      });
    }
  }

  return deltas;
}

function describeConditionChange(
  onChain: OnChainFunction,
  wanted: ScopedFunction,
): string {
  const lines: string[] = ["parameter conditions differ"];
  const left = onChain.conditions ?? [];
  const right = wanted.conditions;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b)) {
      continue;
    }
    lines.push(
      `      chain  ${a === undefined ? "—" : describeCondition(a, index)}`,
      `      preset ${b === undefined ? "—" : describeCondition(b, index)}`,
    );
  }

  return lines.join("\n");
}

/** The diff, rendered. Readable by someone who did not write the preset. */
export function renderDiff(
  deltas: readonly Delta[],
  context: { roleKey: Hex; rolesModifier: Address; asOfBlock: bigint; events: number },
): string {
  const lines: string[] = [
    `roles      ${context.rolesModifier}`,
    `role       ${context.roleKey}`,
    `read from  ${context.events} event(s), state as of block ${context.asOfBlock}`,
    "",
  ];

  if (deltas.length === 0) {
    lines.push("no difference — the chain already says exactly what the preset says");
    return lines.join("\n");
  }

  const widenings = deltas.filter((delta) => delta.widens);
  /**
   * Authority the chain grants and the preset does not describe.
   *
   * A different question from `widens`, which is about what *applying* the preset would
   * add. These are already live: the agent can make these calls now. They were counted
   * only in the total, under a closing line that said "nothing here grants the role
   * anything it does not already have" — true of applying the preset, and the last thing
   * an operator should read beneath a `transfer` on the token the Safe holds.
   */
  const unlisted = deltas.filter((delta) => delta.kind === "remove");

  for (const delta of deltas) {
    const mark = delta.kind === "add" ? "+" : delta.kind === "remove" ? "-" : "~";
    const tag = delta.widens
      ? "   [WIDENS AUTHORITY]"
      : delta.kind === "remove"
        ? "   [ON CHAIN, NOT IN THE PRESET]"
        : "";
    lines.push(`${mark} ${delta.subject}${tag}`);
    for (const line of delta.detail.split("\n")) lines.push(`    ${line}`);
  }

  lines.push("", `${deltas.length} difference(s).`);

  if (unlisted.length > 0) {
    lines.push(
      `${unlisted.length} of them is authority the role has on chain right now that this ` +
        "preset does not describe. Applying the preset does not remove it — `roles:revoke`",
      "does. Read those lines first: they are what the agent can already do.",
    );
  }

  lines.push(
    widenings.length === 0
      ? "Applying this preset grants the role nothing it does not already have."
      : `${widenings.length} line(s) would widen what the agent may do. Read every ` +
          "[WIDENS AUTHORITY] line again before applying.",
  );

  return lines.join("\n");
}
