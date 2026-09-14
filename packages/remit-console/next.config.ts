import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The console reads the repository's own files — receipts, the Remit, the review queue.
 * It is an operator tool for one machine, not a hosted service, and it has no database.
 *
 * The workspace root has to be named explicitly: in a pnpm monorepo Turbopack resolves it
 * from the nearest lockfile, which is two directories up, and without this it cannot find
 * `next` itself.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const config: NextConfig = {
  turbopack: { root: REPO_ROOT },
  outputFileTracingRoot: REPO_ROOT,
  typedRoutes: true,
};

export default config;
