/**
 * @remit/core — the shared vocabulary: the Remit, its digest, the intent schemas, the
 * envelope check (G1) and receipt verification.
 *
 * Phase 0 ships only the verified chain constants and ABIs. The schema, eip712, compile
 * and verify modules land in P2 (PLAN.md 1.6-1.7); they are deliberately absent rather
 * than stubbed, because a stub that returns a plausible value is the failure mode this
 * project exists to remove (CLAUDE.md §2.1).
 */
export * from "./chain/index.js";
