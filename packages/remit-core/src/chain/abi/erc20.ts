/**
 * The two ERC-20 entry points the preset scopes. Signatures are EIP-20 canonical
 * (https://eips.ethereum.org/EIPS/eip-20); `approve` selector 0x095ea7b3 confirmed with
 * `cast sig`, and the deployment at `USDC[8453]` answers `symbol() = "USDC"` and
 * `decimals() = 6` on chain. Verified 2026-09-13, and re-read from both chains by
 * `verify:constants`.
 */
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
