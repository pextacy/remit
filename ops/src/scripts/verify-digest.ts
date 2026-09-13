/**
 * Re-derive `remitHash` with a second, independent implementation.
 *
 *   pnpm --filter ops remit:verify-digest --network anvil
 *
 * `@remit/core` computes the digest with viem. This script computes the same digest with
 * foundry's `cast`, from the EIP-712 definition rather than from any shared code, and
 * compares. Two libraries agreeing is evidence; one library agreeing with itself is not,
 * and RM-2 says a third party must be able to reproduce this from the committed
 * documents.
 *
 * It also re-hashes the limits document from the file on disk, so the `limitsHash` inside
 * the Remit is checked against the bytes anyone can read rather than against whatever was
 * in memory when it was issued.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  limitsHash,
  limitsSchema,
  REMIT_DOMAIN_NAME,
  REMIT_DOMAIN_VERSION,
  REMIT_TYPE_STRING,
  remitDigest,
  remitSchema,
} from "@remit/core";
import { type Hex, keccak256, toBytes } from "viem";
import { networkFrom, parseArgs } from "../lib/args.js";
import { fail, logEvent, say } from "../lib/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const EIP712_DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

function cast(args: readonly string[]): string {
  try {
    return execFileSync("cast", args, { encoding: "utf8" }).trim();
  } catch (error) {
    return fail(`cast ${args[0]} failed — is foundry installed? ${String(error)}`);
  }
}

function castKeccakString(value: string): Hex {
  return cast(["keccak", value]) as Hex;
}

function castKeccakHex(value: Hex): Hex {
  return cast(["keccak", value]) as Hex;
}

function abiEncode(signature: string, args: readonly string[]): Hex {
  return cast(["abi-encode", signature, ...args]) as Hex;
}

const args = parseArgs();
const network = networkFrom(args);

const bundlePath = join(REPO, "ops", "remits", `${network.name}.json`);
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(bundlePath, "utf8")) as unknown;
} catch {
  fail(`no Remit at ops/remits/${network.name}.json — run remit:issue first`);
}

const parsed = raw as { remitHash: Hex; remit: unknown; limits: unknown };
const remit = remitSchema.parse(parsed.remit);
const limits = limitsSchema.parse(parsed.limits);

// ---- 1. the limits document hashes to what the Remit binds -----------------
const recomputedLimits = limitsHash(limits);
const limitsOk = recomputedLimits === remit.limitsHash;
say(`limitsHash   file ${remit.limitsHash}`);
say(`             recomputed ${recomputedLimits}  ${limitsOk ? "match" : "MISMATCH"}`);

// Canonical JSON must be stable under key reordering, or the hash means nothing.
const shuffled = Object.fromEntries(
  Object.entries(limits as Record<string, unknown>).reverse(),
) as Record<string, unknown>;
const shuffledHash = keccak256(toBytes(canonicalJson(shuffled)));
const canonicalOk = shuffledHash === recomputedLimits;
say(
  `             same document, keys reversed → ${shuffledHash} ${canonicalOk ? "match" : "MISMATCH"}`,
);

// ---- 2. the digest, recomputed by foundry ----------------------------------
const typeHash = castKeccakString(REMIT_TYPE_STRING);
const domainTypeHash = castKeccakString(EIP712_DOMAIN_TYPE);
const nameHash = castKeccakString(REMIT_DOMAIN_NAME);
const versionHash = castKeccakString(REMIT_DOMAIN_VERSION);

const domainSeparator = castKeccakHex(
  abiEncode("f(bytes32,bytes32,bytes32,uint256,address)", [
    domainTypeHash,
    nameHash,
    versionHash,
    String(remit.chainId),
    remit.safe,
  ]),
);

const structHash = castKeccakHex(
  abiEncode(
    "f(bytes32,bytes32,bytes32,address,address,bytes32,bytes32,uint256,uint64,uint64,uint256)",
    [
      typeHash,
      remit.strategyHash,
      remit.workflowHash,
      remit.safe,
      remit.rolesModifier,
      remit.roleKey,
      remit.limitsHash,
      String(remit.chainId),
      String(remit.notBefore),
      String(remit.notAfter),
      remit.nonce,
    ],
  ),
);

// EIP-712: keccak256(0x1901 ‖ domainSeparator ‖ structHash)
const castDigest = castKeccakHex(
  `0x1901${domainSeparator.slice(2)}${structHash.slice(2)}` as Hex,
);

const viemDigest = remitDigest(remit);
const digestOk = castDigest === viemDigest && viemDigest === parsed.remitHash;

say("");
say(`typeHash         ${typeHash}`);
say(`domainSeparator  ${domainSeparator}`);
say(`structHash       ${structHash}`);
say("");
say(`remitHash  viem    ${viemDigest}`);
say(`remitHash  cast    ${castDigest}`);
say(`remitHash  file    ${parsed.remitHash}`);
say(`                   ${digestOk ? "three independent paths agree" : "MISMATCH"}`);

logEvent("remit.digest.verified", {
  network: network.name,
  remitHash: viemDigest,
  limitsOk,
  canonicalOk,
  digestOk,
});

if (!limitsOk || !canonicalOk || !digestOk) {
  fail("the Remit does not reproduce — do not build anything on this document");
}
