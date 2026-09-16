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

/** One observed request. The name arrives a tick after the count does — see below. */
type Seen = { method: string };

export type CountingClient = {
  readonly client: PublicClient;
  /** Requests made since the last `reset()`. */
  count(): number;
  reset(): void;
  /** The JSON-RPC methods seen, in order. Empty is the claim NH-1 is making. */
  methods(): readonly string[];
};

export function countingClientFor(network: Network): CountingClient {
  let seen: Seen[] = [];

  const counting = http(network.rpcUrl, {
    onFetchRequest(request) {
      // The method, not the URL. Every request in a run goes to the same endpoint, so a
      // list of URLs said "the same node, eight times" where the evidence NH-1 wants is
      // *which* calls were made — and a reader checking "no network call at all" against
      // a list of identical URLs has to take the count on trust.
      const entry: Seen = { method: "(reading)" };
      seen.push(entry);

      // Read from a clone: the original body is a stream the real request still needs,
      // and consuming it here would break the request being counted. `onFetchRequest` is
      // synchronous, so the name is filled in on the record already in the array — the
      // count is exact immediately, the name a tick later.
      void request
        .clone()
        .text()
        .then((body) => {
          const parsed = JSON.parse(body) as
            | { method?: string }
            | readonly { method?: string }[];
          entry.method = Array.isArray(parsed)
            ? parsed.map((call) => call.method ?? "?").join("+")
            : ((parsed as { method?: string }).method ?? "?");
        })
        .catch(() => {
          entry.method = "(unreadable)";
        });
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
    methods: () => seen.map((entry) => entry.method),
  };
}
