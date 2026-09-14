/**
 * A chain client that counts every request it makes.
 *
 * NH-1 claims that a G1 refusal costs *no network call at all*. That is a claim about
 * what did not happen, which is the hardest kind to evidence — so the scenario runner
 * counts RPC requests around the gate and reports the number, rather than asserting the
 * property in prose.
 *
 * It wraps viem's own HTTP transport, so what is being counted is the real traffic the
 * real client would make.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { chainFor } from "./clients.js";
import type { Network } from "./networks.js";

export type CountingClient = {
  readonly client: PublicClient;
  /** Requests made since the last `reset()`. */
  count(): number;
  reset(): void;
  /** The JSON-RPC methods seen, in order. */
  methods(): readonly string[];
};

export function countingClientFor(network: Network): CountingClient {
  let seen: string[] = [];

  const counting = http(network.rpcUrl, {
    onFetchRequest(request) {
      // The body is a stream we must not consume — the method name is enough, and
      // reading it here would break the request we are counting.
      seen.push(request.url);
    },
  });

  const client = createPublicClient({
    chain: chainFor(network),
    transport: counting,
  }) as PublicClient;

  return {
    client,
    count: () => seen.length,
    reset: () => {
      seen = [];
    },
    methods: () => [...seen],
  };
}
