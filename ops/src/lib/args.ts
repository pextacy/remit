/**
 * The smallest argument parser that still refuses to do the dangerous thing by default.
 *
 * Every script takes `--network`, defaulting to Base Sepolia. Mainnet additionally
 * requires `--confirm`; there is no path that reaches Base mainnet by accident
 * (CLAUDE.md §2.4).
 */

import { fail, say } from "./log.js";
import { type Network, resolveNetwork } from "./networks.js";

export type Args = {
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
};

export function parseArgs(argv: readonly string[] = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(key, next);
      i += 1;
    } else {
      flags.add(key);
    }
  }

  return { flags, options };
}

export function option(args: Args, key: string): string | undefined {
  return args.options.get(key);
}

export function requireOption(args: Args, key: string): string {
  const value = args.options.get(key);
  if (value === undefined) fail(`--${key} is required`);
  return value;
}

/** Resolve the network and enforce the mainnet guard in one place. */
export function networkFrom(args: Args): Network {
  const network = resolveNetwork(args.options.get("network") ?? "base-sepolia");

  if (network.isMainnet && !args.flags.has("confirm")) {
    fail("--network base moves real money: re-run with --confirm");
  }
  if (network.isMainnet) {
    say("⚠️  BASE MAINNET. Real funds. Caps: 5 USDC per transaction, 25 USDC per day.");
  }

  return network;
}
