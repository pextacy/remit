/**
 * `remit-core` as a command, so there is exactly one implementation of every rule.
 *
 * The bridge is Python and the core is TypeScript. That split is in CLAUDE.md §3 and it is
 * the right one — the Almanak seam is Python, the chain work is viem — but it creates the
 * obvious hazard: two implementations of canonical JSON, or of the envelope check, are two
 * *different* implementations the first time someone fixes a bug in one of them. A hash
 * rule that disagrees with itself across a process boundary makes the whole receipt chain
 * worthless.
 *
 * So Python does not reimplement any of it. It calls this, over stdin and stdout, with
 * JSON in and JSON out. One gate, one serialiser, one hash.
 *
 *   echo '{"remit":…,"limits":…,"intent":…,"now":…,"ledger":[]}' | remit-core envelope
 *   echo '{"dir":"receipts/base-sepolia"}' | remit-core receipt:verify
 *
 * Exit codes: 0 the answer is yes, 2 the answer is a refusal, 1 the input was unusable.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  keccak256,
  type PublicClient,
  toBytes,
} from "viem";
import { z } from "zod";
import { canonicalJson } from "./canonical/json.js";
import { erc20Abi } from "./chain/abi/erc20.js";
import { rolesAbi } from "./chain/abi/roles.js";
import { USDC, USDC_DECIMALS } from "./chain/addresses.js";
import { decodeRevert, formatRevert, isUndecodable } from "./chain/decode-revert.js";
import { Operation } from "./chain/roles-enums.js";
import { compileIntent } from "./compile/action.js";
import { remitDigest } from "./eip712/remit.js";
import { receiptBodySchema } from "./receipts/schema.js";
import { appendReceipt, verifyChainAt } from "./receipts/store.js";
import { checkPresetDrift } from "./roles/drift.js";
import { intentSchema } from "./schema/intent.js";
import { limitsHash, limitsSchema } from "./schema/limits.js";
import { bytes32Schema, chainIdSchema } from "./schema/primitives.js";
import { remitSchema } from "./schema/remit.js";
import { checkEnvelope } from "./verify/envelope.js";
import { ledgerEntrySchema } from "./verify/ledger.js";

function emit(value: unknown, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(exitCode);
}

function fail(message: string, detail?: unknown): never {
  emit({ ok: false, error: { code: "CLI_INPUT_INVALID", message, detail } }, 1);
}

function readStdin(): unknown {
  try {
    return JSON.parse(readFileSync(0, "utf8")) as unknown;
  } catch (error) {
    fail("stdin is not JSON", String(error));
  }
}

const command = process.argv[2];

switch (command) {
  case "envelope": {
    const input = z
      .object({
        remit: z.unknown(),
        limits: z.unknown(),
        chainId: chainIdSchema,
        intent: z.unknown(),
        now: z.number().int(),
        ledger: z.array(ledgerEntrySchema).default([]),
        seenStrategyHash: z.string().optional(),
      })
      .safeParse(readStdin());
    if (!input.success) fail("envelope input invalid", input.error.issues);

    const remit = remitSchema.safeParse(input.data.remit);
    if (!remit.success) fail("remit invalid", remit.error.issues);
    const limits = limitsSchema.safeParse(input.data.limits);
    if (!limits.success) fail("limits invalid", limits.error.issues);

    const result = checkEnvelope({
      remit: remit.data,
      limits: limits.data,
      chainId: input.data.chainId,
      intent: input.data.intent,
      now: input.data.now,
      ledger: input.data.ledger,
      ...(input.data.seenStrategyHash === undefined
        ? {}
        : { seenStrategyHash: input.data.seenStrategyHash }),
    });

    if (!result.ok) emit({ ok: false, error: result.error }, 2);

    const { decision } = result;
    emit({
      ok: true,
      decision: {
        intent: decision.intent,
        action: {
          kind: decision.action.kind,
          target: decision.action.target,
          signature: decision.action.signature,
          selector: decision.action.selector,
          calldata: decision.action.calldata,
          counterparty: decision.action.counterparty,
          description: decision.action.description,
        },
        usd: decision.usd,
        usdMicros: decision.usdMicros.toString(),
        requiresReview: decision.requiresReview,
        reviewReason: decision.reviewReason ?? null,
        headroomMicros: decision.headroomMicros.toString(),
        entry: decision.entry,
      },
    });
    break;
  }

  case "compile": {
    const input = z
      .object({ chainId: chainIdSchema, intent: z.unknown() })
      .safeParse(readStdin());
    if (!input.success) fail("compile input invalid", input.error.issues);

    const intent = intentSchema.safeParse(input.data.intent);
    if (!intent.success) fail("intent invalid", intent.error.issues);

    const action = compileIntent(input.data.chainId, intent.data);
    emit({
      ok: true,
      action: {
        kind: action.kind,
        target: action.target,
        signature: action.signature,
        selector: action.selector,
        calldata: action.calldata,
        counterparty: action.counterparty,
        amount: action.amount.toString(),
        description: action.description,
      },
    });
    break;
  }

  case "hash": {
    const input = z
      .object({
        remit: z.unknown().optional(),
        limits: z.unknown().optional(),
        value: z.unknown().optional(),
        /** A path whose *bytes* are hashed — how `strategyHash` is derived. */
        file: z.string().optional(),
      })
      .safeParse(readStdin());
    if (!input.success) fail("hash input invalid", input.error.issues);

    const out: Record<string, unknown> = { ok: true };
    if (input.data.remit !== undefined) {
      const remit = remitSchema.safeParse(input.data.remit);
      if (!remit.success) fail("remit invalid", remit.error.issues);
      out.remitHash = remitDigest(remit.data);
    }
    if (input.data.limits !== undefined) {
      const limits = limitsSchema.safeParse(input.data.limits);
      if (!limits.success) fail("limits invalid", limits.error.issues);
      out.limitsHash = limitsHash(limits.data);
    }
    if (input.data.value !== undefined) {
      out.canonical = canonicalJson(input.data.value);
    }
    if (input.data.file !== undefined) {
      const path = resolve(process.cwd(), input.data.file);
      try {
        // The file's bytes, exactly as committed. No normalisation, no reformatting:
        // a strategy that differs by one byte is a different strategy.
        out.fileHash = keccak256(toBytes(readFileSync(path, "utf8")));
        out.file = path;
      } catch {
        fail(`cannot read ${path}`);
      }
    }
    emit(out);
    break;
  }

  case "preflight": {
    // G2, as a command. The bridge is Python and must not grow its own chain client:
    // one implementation of "would the Roles Modifier allow this", called from both
    // runtimes, is the only way the gate and the operator tooling cannot drift.
    const input = z
      .object({
        rpcUrl: z.string().url(),
        rolesModifier: z.string(),
        roleKey: bytes32Schema,
        agent: z.string(),
        target: z.string(),
        calldata: z.string(),
      })
      .safeParse(readStdin());
    if (!input.success) fail("preflight input invalid", input.error.issues);

    const client = createPublicClient({
      transport: http(input.data.rpcUrl),
    }) as PublicClient;

    try {
      await client.simulateContract({
        address: getAddress(input.data.rolesModifier),
        abi: rolesAbi,
        functionName: "execTransactionWithRole",
        args: [
          getAddress(input.data.target),
          0n,
          input.data.calldata as `0x${string}`,
          Operation.Call,
          input.data.roleKey,
          true,
        ],
        account: getAddress(input.data.agent),
      });
      emit({ ok: true });
    } catch (error) {
      const decoded = decodeRevert(error);
      emit(
        {
          ok: false,
          reason: formatRevert(decoded),
          kind: decoded.kind,
          code:
            decoded.kind === "roles_condition_violation"
              ? decoded.statusName
              : decoded.kind === "roles_error"
                ? decoded.name
                : decoded.kind,
          // An undecoded `0x…` is a failed requirement, not an acceptable answer.
          opaque: isUndecodable(decoded),
        },
        2,
      );
    }
    break;
  }

  case "balance": {
    // What a strategy's balance provider reads. A plain view call, here rather than in
    // the bridge so that the bridge holds no chain client at all.
    const input = z
      .object({ rpcUrl: z.string().url(), chainId: chainIdSchema, owner: z.string() })
      .safeParse(readStdin());
    if (!input.success) fail("balance input invalid", input.error.issues);

    const client = createPublicClient({
      transport: http(input.data.rpcUrl),
    }) as PublicClient;

    const raw = (await client.readContract({
      address: getAddress(USDC[input.data.chainId]),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(input.data.owner)],
    })) as bigint;

    emit({
      ok: true,
      asset: "USDC",
      raw: raw.toString(),
      decimals: USDC_DECIMALS,
      formatted: formatUnits(raw, USDC_DECIMALS),
    });
    break;
  }

  case "tx:status": {
    const input = z
      .object({ rpcUrl: z.string().url(), txHash: bytes32Schema })
      .safeParse(readStdin());
    if (!input.success) fail("tx:status input invalid", input.error.issues);

    const client = createPublicClient({
      transport: http(input.data.rpcUrl),
    }) as PublicClient;

    try {
      const receipt = await client.getTransactionReceipt({ hash: input.data.txHash });
      const head = await client.getBlockNumber();
      emit({
        ok: true,
        status: receipt.status,
        blockNumber: Number(receipt.blockNumber),
        confirmations: Number(head - receipt.blockNumber) + 1,
        gasUsed: receipt.gasUsed.toString(),
      });
    } catch {
      emit({
        ok: true,
        status: "pending",
        blockNumber: 0,
        confirmations: 0,
        gasUsed: "0",
      });
    }
    break;
  }

  case "preset:check": {
    const input = z
      .object({
        rpcUrl: z.string().url(),
        chainId: chainIdSchema,
        remit: z.unknown(),
        limits: z.unknown(),
        rolesModifier: z.string(),
        agent: z.string(),
        fromBlock: z.number().int().min(0).optional(),
        signatures: z.array(z.string()).optional(),
      })
      .safeParse(readStdin());
    if (!input.success) fail("preset:check input invalid", input.error.issues);

    const remit = remitSchema.safeParse(input.data.remit);
    if (!remit.success) fail("remit invalid", remit.error.issues);
    const limits = limitsSchema.safeParse(input.data.limits);
    if (!limits.success) fail("limits invalid", limits.error.issues);

    const client = createPublicClient({
      transport: http(input.data.rpcUrl),
    }) as PublicClient;

    const check = await checkPresetDrift({
      client,
      chainId: input.data.chainId,
      remit: remit.data,
      limits: limits.data,
      rolesModifier: getAddress(input.data.rolesModifier),
      agent: getAddress(input.data.agent),
      ...(input.data.fromBlock === undefined
        ? {}
        : { fromBlock: BigInt(input.data.fromBlock) }),
      ...(input.data.signatures === undefined
        ? {}
        : { signatures: input.data.signatures as `0x${string}`[] }),
    });

    emit({ ok: check.ok, check }, check.ok ? 0 : 2);
    break;
  }

  case "receipt:append": {
    const input = z
      .object({ dir: z.string().min(1), body: z.unknown() })
      .safeParse(readStdin());
    if (!input.success) fail("receipt:append input invalid", input.error.issues);

    // `sequence` and `prevHash` are the store's to assign: a writer that picks its own
    // place in the chain can rewrite history without the chain noticing.
    const body = receiptBodySchema
      .omit({ sequence: true, prevHash: true })
      .safeParse(input.data.body);
    if (!body.success) fail("receipt body invalid", body.error.issues);

    const { receipt, file } = appendReceipt(
      resolve(process.cwd(), input.data.dir),
      body.data,
    );
    emit({ ok: true, file, selfHash: receipt.selfHash, sequence: receipt.sequence });
    break;
  }

  case "receipt:verify": {
    const input = z
      .object({
        dir: z.string().min(1),
        remit: z.unknown().optional(),
        limits: z.unknown().optional(),
      })
      .safeParse(readStdin());
    if (!input.success) fail("receipt:verify input invalid", input.error.issues);

    const documents =
      input.data.remit === undefined || input.data.limits === undefined
        ? undefined
        : { remit: input.data.remit, limits: input.data.limits };

    // Paths are resolved against the caller's working directory, which is not this
    // package's: a filtered pnpm script runs from the package directory, and a relative
    // path that silently resolved to nothing would verify an empty chain and pass.
    const dir = resolve(process.cwd(), input.data.dir);

    let verification: ReturnType<typeof verifyChainAt>;
    try {
      verification = verifyChainAt(dir, documents);
    } catch (error) {
      emit(
        {
          ok: false,
          error: {
            code: "RECEIPTS_MISSING",
            message: error instanceof Error ? error.message : String(error),
            dir,
          },
        },
        2,
      );
    }

    emit({ ok: verification.ok, dir, verification }, verification.ok ? 0 : 2);
    break;
  }

  default:
    fail(
      `unknown command ${String(command)}`,
      "expected one of: envelope, compile, hash, receipt:append, receipt:verify",
    );
}
