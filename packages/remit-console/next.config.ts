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

  /**
   * The evidence travels with the deployment.
   *
   * Every page here reads files this package does not import — receipts, the Remit, the
   * deployment record — so nothing traces them and a hosted build would ship a console
   * with nothing to show. Named one directory at a time rather than by a wide glob: the
   * three that are evidence go, and the review queue (a moment, not a record) and every
   * key-bearing file stay where they are.
   */
  outputFileTracingIncludes: {
    "/**": [
      "../../receipts/base-sepolia/**",
      "../../ops/remits/base-sepolia.json",
      "../../ops/deployments/base-sepolia.json",
    ],
  },
};

export default config;
