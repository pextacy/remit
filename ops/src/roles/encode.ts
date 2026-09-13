/**
 * Turn a preset into the calls that apply it, and into something a human can read before
 * they are sent.
 *
 * `roles:diff` printing this, and an operator actually reading it, is the control that
 * stops a wrong preset from being applied (PRD.md §9). The encoder therefore produces the
 * two together, from one source.
 */

import { Clearance, ROLES_STATUS, rolesAbi } from "@remit/core";
import { type Address, encodeFunctionData, type Hex } from "viem";
import type { Preset } from "./preset.js";

export type PresetCall = {
  readonly label: string;
  readonly data: Hex;
};

/**
 * `scopeTarget` sets a target's clearance to `Function`, which means "only the functions
 * I scope on it are callable". It must come before `scopeFunction` for that target.
 */
export function encodePreset(preset: Preset): readonly PresetCall[] {
  const calls: PresetCall[] = [];

  for (const target of preset.targets) {
    calls.push({
      label: `scopeTarget ${target}`,
      data: encodeFunctionData({
        abi: rolesAbi,
        functionName: "scopeTarget",
        args: [preset.roleKey, target],
      }),
    });
  }

  for (const fn of preset.functions) {
    calls.push({
      label: `scopeFunction ${fn.label}`,
      data: encodeFunctionData({
        abi: rolesAbi,
        functionName: "scopeFunction",
        args: [
          preset.roleKey,
          fn.target,
          fn.selector,
          fn.conditions.map((condition) => ({
            parent: condition.parent,
            paramType: condition.paramType,
            operator: condition.operator,
            compValue: condition.compValue,
          })),
          fn.options,
        ],
      }),
    });
  }

  return calls;
}

/** The preset as prose. This is what `roles:diff` prints and what P6 reads aloud. */
export function describePreset(preset: Preset, safe: Address): string {
  const lines: string[] = [
    `role      ${preset.roleKey}`,
    `safe      ${safe}`,
    `chain     ${preset.chainId}`,
    "",
    `targets   ${preset.targets.length} (clearance → ${Object.keys(Clearance)[Clearance.Function]})`,
  ];

  for (const target of preset.targets) lines.push(`          ${target}`);
  lines.push("", `functions ${preset.functions.length}`);

  for (const fn of preset.functions) {
    lines.push("", `  ${fn.label}`);
    lines.push(`    target    ${fn.target}`);
    lines.push(`    function  ${fn.signature}  ${fn.selector}`);
    lines.push(`    options   ExecutionOptions.None (no value, no delegatecall)`);
    for (const note of fn.parameterNotes) lines.push(`    ├─ ${note}`);
  }

  lines.push(
    "",
    "A call outside this set reverts inside the Roles Modifier with a named",
    `status from the ${ROLES_STATUS.length}-value Status enum, and costs the agent nothing but the`,
    "simulation it should have run first.",
  );

  return lines.join("\n");
}
