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

function check(label: string, ok: boolean, detail: string): void {
  const mark = ok ? "ok  " : "FAIL";
  if (!ok) failures += 1;
  process.stdout.write(`${mark} ${label.padEnd(46)} ${detail}\n`);
}

async function hasCode(client: PublicClient, address: Address): Promise<number> {
  const code = await client.getCode({ address });
  return code === undefined ? 0 : (code.length - 2) / 2;
}

async function verifyChain(chainId: SupportedChainId): Promise<void> {
  const rpc = PUBLIC_RPC[chainId];
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  process.stdout.write(`\nchain ${chainId} via ${rpc}\n`);

  const observed = await client.getChainId();
  check("eth_chainId matches", observed === chainId, String(observed));

  for (const [label, address] of [
    ["zodiac roles mastercopy", ROLES_MASTERCOPY],
    ["zodiac module proxy factory", MODULE_PROXY_FACTORY],
    ["safe singleton", SAFE_SINGLETON],
    ["safe l2 singleton", SAFE_L2_SINGLETON],
    ["safe proxy factory", SAFE_PROXY_FACTORY],
  ] as const) {
    const size = await hasCode(client, getAddress(address));
    check(`${label} has code`, size > 0, `${size} bytes`);
  }

  for (const [label, address] of [
    ["safe singleton", SAFE_SINGLETON],
    ["safe l2 singleton", SAFE_L2_SINGLETON],
  ] as const) {
    const version = await client.readContract({
      address: getAddress(address),
      abi: SAFE_VERSION_ABI,
      functionName: "VERSION",
    });
    check(`${label} VERSION`, version === SAFE_VERSION, version);
  }

  const usdc = getAddress(USDC[chainId]);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }),
  ]);
  check("usdc symbol", symbol === "USDC", symbol);
  check("usdc decimals", decimals === USDC_DECIMALS, String(decimals));

  const provider = await client.readContract({
    address: getAddress(AAVE_V3_POOL[chainId]),
    abi: aavePoolAbi,
    functionName: "ADDRESSES_PROVIDER",
  });
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
