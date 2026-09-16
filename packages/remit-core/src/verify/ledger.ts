/**
 * What the agent has already done, and how much of the remit is left.
 *
 * Pure data. G1 takes the ledger as an argument rather than reading it, so the gate stays
 * a function of its inputs and can be re-run over a receipt chain to check a past decision
 * (PRD.md G1-1). Persisting it across a bridge restart is G1-5, and belongs to whatever
 * owns the process — not here.
 */
import { z } from "zod";

/**
 * The same shape as a Zod schema, for the process boundary. The bridge sends its ledger
 * across as JSON, and an entry that arrives malformed must be a refusal rather than a
 * silently-zero spend.
 */
export const ledgerEntrySchema = z
  .object({
    at: z.number().int(),
    usdMicros: z.string().regex(/^(0|[1-9][0-9]*)$/),
    kind: z.enum(["approve", "supply", "withdraw"]),
  })
  .strict();

export type LedgerEntry = {
  /** Unix seconds at which the action was admitted by G1. */
  readonly at: number;
  /** Notional in integer micro-dollars. */
  readonly usdMicros: string;
  readonly kind: "approve" | "supply" | "withdraw";
};

export const DAY_SECONDS = 86_400;
export const HOUR_SECONDS = 3_600;

/**
 * Is this entry inside the window ending at `now`?
 *
 * There is deliberately no upper bound. An entry stamped in the future is either a clock
 * that moved or a ledger somebody edited, and excluding it — which `entry.at <= now`
 * did — is the one arithmetic that makes a cap *larger*: stamp tomorrow's second on
 * today's spend and the day starts again. Fail-closed here means a future entry keeps
 * counting until the window catches up with it, which is an agent that stops rather than
 * an agent with no cap.
 */
function within(entry: LedgerEntry, now: number, windowSeconds: number): boolean {
  return entry.at > now - windowSeconds;
}

/**
 * Value that has left the Safe in the window.
 *
 * Only `supply` counts. A `withdraw` brings funds back and its recipient is pinned to the
 * Safe by the preset, so it cannot be a way out; counting it would make the cap tighten
 * as the agent unwinds a position, which is backwards. An `approve` is authority rather
 * than movement, and is held by the per-transaction cap instead — counting both the
 * approve and the supply it enables would charge the same dollar twice.
 */
export function spentMicros(
  entries: readonly LedgerEntry[],
  now: number,
  windowSeconds: number = DAY_SECONDS,
): bigint {
  return entries
    .filter((entry) => entry.kind === "supply" && within(entry, now, windowSeconds))
    .reduce((total, entry) => total + BigInt(entry.usdMicros), 0n);
}

/** Every admitted action counts against the rate limit, including refusals' cheaper kin. */
export function countInWindow(
  entries: readonly LedgerEntry[],
  now: number,
  windowSeconds: number = HOUR_SECONDS,
): number {
  return entries.filter((entry) => within(entry, now, windowSeconds)).length;
}
