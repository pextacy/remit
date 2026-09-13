/**
 * Zodiac ModuleProxyFactory v1.2.0 ABI.
 *
 * Source: gnosisguild/zodiac, `mastercopies/factory/1.2.0/ModuleProxyFactory/abi.json`,
 * commit `89352c4f05d4b223b9c555ca963a787fd930da2d`. Verified 2026-09-13.
 *
 * The version is not a guess: the runtime bytecode in that directory's `bytecode.json`
 * is byte-identical to `eth_getCode` at `MODULE_PROXY_FACTORY` on Base Sepolia (2046
 * bytes), and neither 1.0.0 nor 1.1.0 matches.
 *
 * `deployModule(mastercopy, initializer, saltNonce)` deploys an EIP-1167 proxy and calls
 * the initializer on it in the same transaction, then emits `ModuleProxyCreation`.
 */
export const moduleProxyFactoryAbi = [
  {
    inputs: [],
    name: "FailedInitialization",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "address_",
        type: "address",
      },
    ],
    name: "TakenAddress",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "target",
        type: "address",
      },
    ],
    name: "TargetHasNoCode",
    type: "error",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "target",
        type: "address",
      },
    ],
    name: "ZeroAddress",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "address",
        name: "proxy",
        type: "address",
      },
      {
        indexed: true,
        internalType: "address",
        name: "masterCopy",
        type: "address",
      },
    ],
    name: "ModuleProxyCreation",
    type: "event",
  },
  {
    inputs: [
      {
        internalType: "address",
        name: "masterCopy",
        type: "address",
      },
      {
        internalType: "bytes",
        name: "initializer",
        type: "bytes",
      },
      {
        internalType: "uint256",
        name: "saltNonce",
        type: "uint256",
      },
    ],
    name: "deployModule",
    outputs: [
      {
        internalType: "address",
        name: "proxy",
        type: "address",
      },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
