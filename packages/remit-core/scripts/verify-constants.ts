/**
 * Re-derives every row in docs/VERIFIED.md against the live chains.
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

  const observed = await retry("eth_chainId", () => client.getChainId());
  check("eth_chainId matches", observed === chainId, String(observed));

  for (const [label, address] of [
    ["zodiac roles mastercopy", ROLES_MASTERCOPY],
    ["zodiac module proxy factory", MODULE_PROXY_FACTORY],
    ["safe singleton", SAFE_SINGLETON],
    ["safe l2 singleton", SAFE_L2_SINGLETON],
    ["safe proxy factory", SAFE_PROXY_FACTORY],
  ] as const) {
    const size = await retry(label, () => hasCode(client, getAddress(address)));
    check(`${label} has code`, size > 0, `${size} bytes`);
  }

  for (const [label, address] of [
    ["safe singleton", SAFE_SINGLETON],
    ["safe l2 singleton", SAFE_L2_SINGLETON],
  ] as const) {
    const version = await retry(`${label} VERSION`, () =>
      client.readContract({
        address: getAddress(address),
        abi: SAFE_VERSION_ABI,
        functionName: "VERSION",
      }),
    );
    check(`${label} VERSION`, version === SAFE_VERSION, version);
  }

  const usdc = getAddress(USDC[chainId]);
  const symbol = await retry("usdc symbol", () =>
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "symbol" }),
  );
  const decimals = await retry("usdc decimals", () =>
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
  );
  check("usdc symbol", symbol === "USDC", symbol);
  check("usdc decimals", decimals === USDC_DECIMALS, String(decimals));

  const aToken = getAddress(AAVE_V3_A_USDC[chainId]);
  const underlying = await retry("aUSDC underlying", () =>
    client.readContract({
      address: aToken,
      abi: A_TOKEN_ABI,
      functionName: "UNDERLYING_ASSET_ADDRESS",
    }),
  );
  check("aUSDC underlying is USDC", getAddress(underlying) === usdc, underlying);

  const provider = await retry("aave ADDRESSES_PROVIDER", () =>
    client.readContract({
      address: getAddress(AAVE_V3_POOL[chainId]),
      abi: aavePoolAbi,
      functionName: "ADDRESSES_PROVIDER",
    }),
  );
  const expected = getAddress(AAVE_V3_POOL_ADDRESSES_PROVIDER[chainId]);
  check("aave pool ADDRESSES_PROVIDER", getAddress(provider) === expected, provider);
}

for (const chainId of [BASE, BASE_SEPOLIA] as const) {
  await verifyChain(chainId);
}

process.stdout.write(
  failures === 0
    ? "\nall constants agree with chain\n"
    : `\n${failures} disagreement(s) — fix docs/VERIFIED.md and addresses.ts before building on them\n`,
);
process.exit(failures === 0 ? 0 : 1);
