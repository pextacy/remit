import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the console reads from.
 *
 * The same directories the bridge and the ops scripts write: receipts, the Remit, the
 * deployment, the review queue. No database and no API between them — the console is a
 * reader of the repository, which is why it can be cut entirely (cut line C7) and leave
 * the gates intact.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..", "..", "..");

export const RECEIPTS_ROOT = join(REPO, "receipts");
export const REVIEW_ROOT = join(REPO, "ops", "review");
export const REMITS_ROOT = join(REPO, "ops", "remits");
export const DEPLOYMENTS_ROOT = join(REPO, "ops", "deployments");

/** The network the console is looking at. One operator, one chain at a time. */
export function activeNetwork(): string {
  return process.env.REMIT_NETWORK ?? "base-sepolia";
}
