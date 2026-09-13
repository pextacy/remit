/**
 * @remit/core — the shared vocabulary.
 *
 * The Remit and its digest, the intent schemas, the compiler that turns an intent into
 * calldata, the envelope check (G1), and the verified chain constants underneath all of
 * it. Everything here is pure: no network, no clock, no filesystem. That is what lets G1
 * be re-run over a committed receipt by someone with no access to our infrastructure.
 *
 * Still to come: receipt chain verification (P3) and the Almanak adapter's typed
 * boundary (P5). Absent rather than stubbed (CLAUDE.md §2.1).
 */

export * from "./canonical/json.js";
export * from "./chain/index.js";
export * from "./compile/action.js";
export * from "./eip712/remit.js";
export * from "./schema/intent.js";
export * from "./schema/limits.js";
export * from "./schema/primitives.js";
export * from "./schema/remit.js";
export * from "./verify/envelope.js";
export * from "./verify/errors.js";
export * from "./verify/ledger.js";
