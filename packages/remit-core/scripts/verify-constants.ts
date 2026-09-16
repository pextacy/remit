/**
 * Re-derives every constant in `src/chain/addresses.ts` against the live chains.
 *
 * This is the capture script CLAUDE.md §2.1 asks for: the constants in
 * `src/chain/addresses.ts` came from pinned upstream sources, and this proves the chain
 * agrees with them today. Run it before P1 starts, again before the mainnet execution in
 * P6, and again on Friday morning.
 *
 *   pnpm --filter @remit/core verify:constants
 *
 * It reads only. It sends nothing, signs nothing, and needs no key — public RPCs are
 * enough. Exit code is non-zero on the first disagreement.
 */
import {
  type Address,
  createPublicClient,
  getAddress,
  http,
  type PublicClient,
} from "viem";
import {
  AAVE_V3_A_USDC,
  AAVE_V3_POOL,
  AAVE_V3_POOL_ADDRESSES_PROVIDER,
  aavePoolAbi,
  BASE,
  BASE_SEPOLIA,
  erc20Abi,
  MODULE_PROXY_FACTORY,
  PUBLIC_RPC,
  ROLES_MASTERCOPY,
  SAFE_L2_SINGLETON,
  SAFE_PROXY_FACTORY,
  SAFE_SINGLETON,
  SAFE_VERSION,
  type SupportedChainId,
  USDC,
  USDC_DECIMALS,
} from "../src/index.js";

const A_TOKEN_ABI = [
  {
    type: "function",
    name: "UNDERLYING_ASSET_ADDRESS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const SAFE_VERSION_ABI = [
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

let failures = 0;
/**
 * Reads that never answered.
 *
 * Counted apart from disagreements, because they are a different fact and this script
 * runs immediately before a mainnet execution. "The constant changed" and "the endpoint
 * would not answer" call for different actions, and an operator who is about to spend
 * real money should not have to guess which happened. Both are non-zero exits: you may
 * not proceed on a constant nobody verified.
 */
let unknown = 0;

/**
 * Public RPCs rate-limit, and a rate-limited read is not a constant that changed.
 * Without this, the script that exists to catch drift would occasionally invent some.
 */
async function retry<T>(what: string, read: () => Promise<T>, attempts = 6): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        // Linear, then long: a public endpoint that is rate-limiting wants seconds, not
        // milliseconds, and this script runs before a mainnet execution rather than in a
        // loop.
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt * attempt));
      }
    }
  }
  throw new Error(
    `${what} could not be read after ${attempts} attempts: ${String(lastError)}`,
  );
}

function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? "ok  " : "FAIL";
  if (!ok) failures += 1;
  process.stdout.write(`${mark} ${label.padEnd(46)} ${detail}\n`);
}

/** A read that could not be made. Not a pass, and not a constant that changed. */
function unreadable(label: string, error: unknown): void {
  unknown += 1;
  const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
  process.stdout.write(`??   ${label.padEnd(46)} ${detail}\n`);
}

/**
 * Run one check, and let an endpoint that will not answer be its own outcome.
 *
 * `retry` throws once it gives up, and every call sat unguarded under a top-level
 * `await` — so a rate-limited public RPC took the whole script down with a stack trace,
 * part-way through, leaving the operator without even a list of what *had* been checked.
 * The script whose job is to be run before spending real money is the last one that
 * should end that way.
 */
async function attempt(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    unreadable(label, error);
  }
}

async function hasCode(client: PublicClient, address: Address): Promise<number> {
  const code = await client.getCode({ address });
  return code === undefined ? 0 : (code.length - 2) / 2;
}

/**
 * A private endpoint when one is configured, the public one otherwise.
 *
 * The public Base RPCs rate-limit, and this script is the one that runs immediately
 * before a mainnet execution — the moment when "could not read" must not be mistaken for
 * "the constant changed". An operator with a key should be able to use it.
 */
function rpcFor(chainId: SupportedChainId): string {
  const override =
    chainId === BASE ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL;
  return override !== undefined && override !== "" ? override : PUBLIC_RPC[chainId];
}

async function verifyChain(chainId: SupportedChainId): Promise<void> {
  const rpc = rpcFor(chainId);
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  process.stdout.write(`\nchain ${chainId} via ${rpc}\n`);

  let observed: number;
  try {
    observed = await retry("eth_chainId", () => client.getChainId());
  } catch (error) {
    unreadable("eth_chainId", error);
    process.stdout.write("     nothing else on this chain was checked\n");
    return;
  }

  check("eth_chainId matches", observed === chainId, String(observed));
  if (observed !== chainId) {
    /**
     * Stop here rather than checking every address against the wrong chain.
     *
     * Each one would come back with no code or no answer, and the operator would read a
     * wall of failures whose single cause is one misconfigured URL — with the real
     * message, this line, scrolled off the top. The reads below also cost six retries
     * each with a quadratic backoff, so a wrong RPC turned a two-second check into
     * several minutes of confident nonsense.
     */
    process.stdout.write(
      `     this endpoint serves chain ${observed}, not ${chainId} — nothing else on ` +
        "this chain was checked. Fix the RPC URL and re-run.\n",
    );
    return;
  }

  for (const [label, address] of [
    ["zodiac roles mastercopy", ROLES_MASTERCOPY],
    ["zodiac module proxy factory", MODULE_PROXY_FACTORY],
    ["safe singleton", SAFE_SINGLETON],
    ["safe l2 singleton", SAFE_L2_SINGLETON],
    ["safe proxy factory", SAFE_PROXY_FACTORY],
  ] as const) {
    await attempt(`${label} has code`, async () => {
      const size = await retry(label, () => hasCode(client, getAddress(address)));
      check(`${label} has code`, size > 0, `${size} bytes`);
    });
  }

  for (const [label, address] of [
    ["safe singleton", SAFE_SINGLETON],
    ["safe l2 singleton", SAFE_L2_SINGLETON],
  ] as const) {
    await attempt(`${label} VERSION`, async () => {
      const version = await retry(`${label} VERSION`, () =>
        client.readContract({
          address: getAddress(address),
          abi: SAFE_VERSION_ABI,
          functionName: "VERSION",
        }),
      );
      check(`${label} VERSION`, version === SAFE_VERSION, version);
    });
  }

  const usdc = getAddress(USDC[chainId]);
  await attempt("usdc symbol/decimals", async () => {
    const symbol = await retry("usdc symbol", () =>
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "symbol" }),
    );
    const decimals = await retry("usdc decimals", () =>
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
    );
    check("usdc symbol", symbol === "USDC", symbol);
    check("usdc decimals", decimals === USDC_DECIMALS, String(decimals));
  });

  await attempt("aUSDC underlying is USDC", async () => {
    const underlying = await retry("aUSDC underlying", () =>
      client.readContract({
        address: getAddress(AAVE_V3_A_USDC[chainId]),
        abi: A_TOKEN_ABI,
        functionName: "UNDERLYING_ASSET_ADDRESS",
      }),
    );
    check("aUSDC underlying is USDC", getAddress(underlying) === usdc, underlying);
  });

  await attempt("aave pool ADDRESSES_PROVIDER", async () => {
    const provider = await retry("aave ADDRESSES_PROVIDER", () =>
      client.readContract({
        address: getAddress(AAVE_V3_POOL[chainId]),
        abi: aavePoolAbi,
        functionName: "ADDRESSES_PROVIDER",
      }),
    );
    const expected = getAddress(AAVE_V3_POOL_ADDRESSES_PROVIDER[chainId]);
    check("aave pool ADDRESSES_PROVIDER", getAddress(provider) === expected, provider);
  });
}

for (const chainId of [BASE, BASE_SEPOLIA] as const) {
  await verifyChain(chainId);
}

if (failures === 0 && unknown === 0) {
  process.stdout.write("\nall constants agree with chain\n");
} else {
  if (failures > 0) {
    process.stdout.write(
      `\n${failures} disagreement(s) — fix src/chain/addresses.ts before ` +
        "building on them\n",
    );
  }
  if (unknown > 0) {
    // Said separately, because it is a different thing to go and fix. A constant nobody
    // could read is not a constant that changed, and it is not a constant that was
    // verified either.
    process.stdout.write(
      `${unknown} read(s) never answered — those constants are unverified, not wrong. ` +
        "Set BASE_RPC_URL / BASE_SEPOLIA_RPC_URL to an endpoint that answers and re-run.\n",
    );
  }
}
process.exit(failures === 0 && unknown === 0 ? 0 : 1);
