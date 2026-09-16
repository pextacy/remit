/**
 * The primitive shapes every boundary is validated against (CLAUDE.md §5).
 *
 * Two rules carried by everything below:
 *
 * - **Addresses are checksummed on the way in.** A lowercase address and a checksummed
 *   one are the same account and two different documents, and a Remit is identified by
 *   the hash of its document.
 * - **Amounts are decimal strings of base units.** Never a number, never a float. 5 USDC
 *   is `"5000000"`, and it stays that byte sequence from the strategy to the receipt.
 */
import { getAddress, isAddress, isHex } from "viem";
import { z } from "zod";

export const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "not an EVM address")
  .transform((value) => getAddress(value));

export const bytes32Schema = z
  .string()
  .refine((value) => isHex(value) && value.length === 66, "not a 32-byte hex string")
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** An unsigned integer as a decimal string: no sign, no exponent, no leading zeroes. */
export const uintStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "not an unsigned decimal integer");

/** Unix seconds. Bounded so a typo of milliseconds-for-seconds is caught here. */
export const unixSecondsSchema = z
  .number()
  .int()
  .min(1_600_000_000, "before 2020 — is this milliseconds?")
  .max(4_102_444_800, "after 2100 — is this milliseconds?");

/**
 * A USD amount as a decimal string, at most 6 decimal places.
 *
 * Kept as a string and converted to integer micro-dollars for every comparison. A cap of
 * "5" that turns into 4.999999999 somewhere is a cap that fails open.
 */
export const usdStringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/, "not a USD amount with at most 6 decimals");

/** The only asset this build moves. A symbol, never an address — see `resolveAsset`. */
export const assetSymbolSchema = z.literal("USDC");
export type AssetSymbol = z.infer<typeof assetSymbolSchema>;

export const chainIdSchema = z.union([z.literal(8453), z.literal(84_532)]);

/** `"5.25"` → `5250000`. Exact, integer, no floating point anywhere on the path. */
export function usdToMicros(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

/**
 * `5250000` → `"5.25"`. Used only for display and log lines.
 *
 * The sign is taken off first and put back at the end. BigInt division truncates toward
 * zero and `%` keeps the sign of the dividend, so `-5n` used to produce a whole part of
 * `0`, a remainder of `-5`, and the string `"0.0000-5"` — which reached the headroom line
 * of the mainnet preamble the moment a cap was lowered below what had already been spent.
 * A number that renders as nonsense on the one screen an operator reads before spending
 * real money is worse than no number: they either distrust every figure beside it or
 * they do not notice.
 */
export function microsToUsd(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const whole = magnitude / 1_000_000n;
  const fraction = (magnitude % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  const rendered = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${rendered}` : rendered;
}
