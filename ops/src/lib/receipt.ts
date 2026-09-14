/**
 * Writing a receipt, from wherever the decision was made.
 *
 * The pipeline writes one per attempt; the scenario runner writes one per demonstrated
 * failure. Both go through here so that a receipt produced by a demo is the same shape,
 * with the same hashes, as one produced by a real run — a failure surface built out of
 * special-cased records would be a failure surface nobody could audit.
 */
import { join } from "node:path";
import {
  appendReceipt,
  type Limits,
  type Receipt,
  type ReceiptBody,
  type Remit,
} from "@remit/core";
import type { Address } from "viem";
import { logEvent, say } from "./log.js";
import type { Network } from "./networks.js";

export type ReceiptContext = {
  readonly network: Network;
  readonly remit: Remit;
  readonly remitHash: `0x${string}`;
  readonly limits: Limits;
  readonly rolesModifier: Address;
  readonly agent: Address;
  readonly receiptsRoot: string;
};

export type ReceiptFields = Pick<
  ReceiptBody,
  "intent" | "action" | "gates" | "outcome" | "submission"
>;

/** Nothing was submitted. The common case for a refusal. */
export const NO_SUBMISSION = {
  path: "none",
  executionId: null,
  workflowId: null,
  txHash: null,
  explorer: null,
  gasUsed: null,
} as const;

export function writeReceipt(
  context: ReceiptContext,
  fields: ReceiptFields,
  options: { at?: number; quiet?: boolean } = {},
): Receipt {
  const { receipt, file } = appendReceipt(
    join(context.receiptsRoot, context.network.name),
    {
      version: 1,
      at: options.at ?? Math.floor(Date.now() / 1000),
      network: context.network.name,
      chainId: context.network.chainId,
      remitHash: context.remitHash,
      strategyHash: context.remit.strategyHash,
      workflowHash: context.remit.workflowHash,
      limitsHash: context.remit.limitsHash,
      roleKey: context.remit.roleKey,
      safe: context.remit.safe,
      rolesModifier: context.rolesModifier,
      agent: context.agent,
      ...fields,
    },
  );

  if (options.quiet !== true) {
    say(`receipt     ${file}  ${receipt.selfHash}`);
  }
  logEvent("receipt.written", {
    file,
    selfHash: receipt.selfHash,
    sequence: receipt.sequence,
    outcome: receipt.outcome,
  });

  return receipt;
}
