/**
 * Aave v3 Pool — only the two functions the Remit envelope allows.
 *
 * Source: aave-dao/aave-v3-origin, `src/contracts/interfaces/IPool.sol` at commit
 * 8305565ae342f1773c42cd2e4593f175fe5968a0 (lines 204 and 243). Verified 2026-09-13.
 *
 * `supply(address,uint256,address,uint16)` → 0x617ba037
 * `withdraw(address,uint256,address)`      → 0x69328dec
 *
 * `onBehalfOf` on supply and `to` on withdraw are the parameters the Roles preset pins
 * `EqualTo` the Safe (PRD.md G4-2). They are the reason exfiltration is structurally
 * impossible rather than merely disallowed.
 */
export const aavePoolAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "ADDRESSES_PROVIDER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;
