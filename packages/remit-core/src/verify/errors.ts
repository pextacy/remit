/**
 * Typed rejections. Never a bare string (CLAUDE.md §5, PRD.md G1-3).
 *
 * Judges test failure paths, and an operator reading "failed" at 02:00 learns nothing.
 * Every rejection carries the code, the field that failed, what the Remit expected and
 * what the intent actually asked for — enough to fix the intent or the preset without
 * reading the source.
 *
 * The codes are phrased against the remit, per the naming convention: an agent may remit
 * only within its remit.
 */
export type EnvelopeErrorCode =
  /** The intent did not parse. Nothing downstream ever sees it. */
  | "INTENT_MALFORMED"
  /** The Remit is for another chain. */
  | "REMIT_CHAIN_MISMATCH"
  /** `now` is outside [notBefore, notAfter]. */
  | "REMIT_NOT_YET_VALID"
  | "REMIT_EXPIRED"
  /** The limits document does not hash to the `limitsHash` the Remit binds. */
  | "REMIT_LIMITS_MISMATCH"
  /** The action is not one the Remit permits. */
  | "OUT_OF_REMIT_KIND"
  | "OUT_OF_REMIT_ASSET"
  | "OUT_OF_REMIT_TARGET"
  | "OUT_OF_REMIT_SELECTOR"
  | "OUT_OF_REMIT_RECIPIENT"
  | "OUT_OF_REMIT_SPENDER"
  /** The amount is permitted in kind but not in size. */
  | "REMIT_CAP_EXCEEDED_PER_TX"
  | "REMIT_CAP_EXCEEDED_DAILY"
  | "REMIT_RATE_LIMIT_EXCEEDED";

export type EnvelopeError = {
  readonly code: EnvelopeErrorCode;
  /** The field of the intent or the limits object that failed. */
  readonly field: string;
  /** What the Remit allows, rendered for a human. */
  readonly expected: string;
  /** What the intent asked for. */
  readonly actual: string;
  /** One sentence. Goes in the receipt and on the console. */
  readonly message: string;
};

export function envelopeError(
  code: EnvelopeErrorCode,
  field: string,
  expected: string,
  actual: string,
  message: string,
): EnvelopeError {
  return { code, field, expected, actual, message };
}

export function formatEnvelopeError(error: EnvelopeError): string {
  return `${error.code}: ${error.message} (${error.field}: expected ${error.expected}, got ${error.actual})`;
}
