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
import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  keccak256,
  type PublicClient,
  TransactionReceiptNotFoundError,
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
import { receiptBodySchema, receiptSchema } from "./receipts/schema.js";
import { appendReceipt, readChain, verifyChainAt } from "./receipts/store.js";
import { reviewItemSchema } from "./review/schema.js";
import { enqueueReview, readDecision } from "./review/store.js";
import { checkPresetDrift } from "./roles/drift.js";
import { intentSchema } from "./schema/intent.js";
import { limitsHash, limitsSchema } from "./schema/limits.js";
import { addressSchema, bytes32Schema, chainIdSchema } from "./schema/primitives.js";
import { remitSchema } from "./schema/remit.js";
import { checkEnvelope } from "./verify/envelope.js";
import { ledgerEntrySchema } from "./verify/ledger.js";

/**
 * The one answer, on stdout, and then the exit code.
 *
 * `writeSync` on fd 1 rather than `process.stdout.write`. Writes to a *pipe* are
 * asynchronous on Linux and macOS, and `process.exit` does not wait for them — so a
 * large answer (`receipt:verify` over a long chain, `preset:check` with several
 * findings) could be cut off mid-object. Every caller of this CLI is a pipe: the Python
 * bridge captures stdout for every gate it runs. The bridge would then report "produced
 * no JSON" and refuse, which is a gate failing for no reason but buffering.
 *
 * `EAGAIN` is possible on a non-blocking pipe whose reader is behind; retrying is the
 * whole handling, because there is nowhere else for the answer to go.
 */
function emit(value: unknown, exitCode = 0): never {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  let written = 0;
  while (written < payload.length) {
    try {
      written += writeSync(1, payload, written, payload.length - written);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") continue;
      // stdout is gone (a closed pipe). The exit code is the only thing left to say.
      break;
    }
  }
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
        // Parsed as addresses and calldata, not as strings. `getAddress` used to run
        // inside the try below, so a typo in an address came back as a *refusal* — the
        // gate reporting a Roles decision that was never asked for.
        rolesModifier: addressSchema,
        roleKey: bytes32Schema,
        agent: addressSchema,
        target: addressSchema,
        calldata: z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "not calldata"),
        /** The chain the caller believes this RPC serves. Checked, not assumed. */
        chainId: chainIdSchema.optional(),
      })
      .safeParse(readStdin());
    if (!input.success) fail("preflight input invalid", input.error.issues);

    const client = createPublicClient({
      transport: http(input.data.rpcUrl),
    }) as PublicClient;

    // G2's answer is only about the chain G2 asked. An RPC URL pointed at the wrong
    // network answers every question confidently and about the wrong Roles instance —
    // usually one that does not exist there, which reads as a clean refusal.
    if (input.data.chainId !== undefined) {
      let served: number;
      try {
        served = await client.getChainId();
      } catch (error) {
        emit(
          {
            ok: false,
            reason: `the RPC did not answer: ${
              error instanceof Error ? error.message.split("\n")[0] : String(error)
            }`,
            kind: "rpc_unreachable",
            code: "RPC_UNREACHABLE",
            opaque: true,
          },
          1,
        );
      }
      if (served !== input.data.chainId) {
        emit(
          {
            ok: false,
            reason: `the RPC serves chain ${served}, the Remit is for ${input.data.chainId}`,
            kind: "chain_mismatch",
            code: "PREFLIGHT_CHAIN_MISMATCH",
            opaque: false,
          },
          1,
        );
      }
    }

    try {
      await client.simulateContract({
        address: input.data.rolesModifier,
        abi: rolesAbi,
        functionName: "execTransactionWithRole",
        args: [
          input.data.target,
          0n,
          input.data.calldata as `0x${string}`,
          Operation.Call,
          input.data.roleKey,
          true,
        ],
        account: input.data.agent,
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
    } catch (error) {
      // "The node has never heard of this hash" and "the node did not answer" are
      // different facts, and reporting both as `pending` told a caller a transaction was
      // in flight when what had actually happened was that the RPC was down. A status
      // screen that says "pending" because nobody asked is the same failure as a gate
      // that passes because nobody checked.
      if (error instanceof TransactionReceiptNotFoundError) {
        emit({
          ok: true,
          status: "pending",
          blockNumber: 0,
          confirmations: 0,
          gasUsed: "0",
        });
      }
      emit(
        {
          ok: false,
          status: "unknown",
          error: {
            code: "RPC_UNREACHABLE",
            message:
              error instanceof Error ? error.message.split("\n")[0] : String(error),
          },
        },
        1,
      );
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

  // ---- G3, as two commands ------------------------------------------------
  //
  // The queue is a directory of JSON files and the console already reads it. What was
  // missing was a way for the *bridge* to use it: the Python path recorded "G3 skipped"
  // and carried on, so the one gate whose cost is a person's attention did not exist on
  // the product path at all. It is reached from here rather than reimplemented there,
  // for the same reason every other rule is — one schema, one id check, one definition
  // of what a pending item is.
  case "review:enqueue": {
    const input = z
      .object({ dir: z.string().min(1), item: z.unknown() })
      .safeParse(readStdin());
    if (!input.success) fail("review:enqueue input invalid", input.error.issues);

    const item = reviewItemSchema.safeParse(input.data.item);
    if (!item.success) fail("review item invalid", item.error.issues);

    const file = enqueueReview(resolve(process.cwd(), input.data.dir), item.data);
    emit({ ok: true, file, id: item.data.id });
    break;
  }

  case "review:decision": {
    const input = z
      .object({ dir: z.string().min(1), id: z.string().min(1) })
      .safeParse(readStdin());
    if (!input.success) fail("review:decision input invalid", input.error.issues);

    const decision = readDecision(resolve(process.cwd(), input.data.dir), input.data.id);
    // No decision yet and an unreadable one are the same answer here — *not yet* — and
    // the caller treats silence as a refusal when its deadline passes. Saying "declined"
    // for a file that failed to parse would attribute a refusal to a person who did not
    // make it.
    emit({ ok: true, decided: decision !== undefined, decision: decision ?? null });
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

  /**
   * G3-5, as a command: the `strategyHash` this agent last actually executed under.
   *
   * G1 takes it as an argument and holds the next action for review when it differs from
   * the one the Remit binds — a new strategy version's first transaction is the one worth
   * looking at, and it is exactly the one a notional threshold waves through.
   *
   * The ops pipeline computed it inline from the chain of receipts and the bridge did
   * not, so the rule existed on the hand-run path and was absent from the path a strategy
   * actually runs through. It is read here rather than reimplemented in Python for the
   * same reason every other rule is: the answer comes from parsing receipts against the
   * receipt schema, and a second parser is a second answer.
   */
  case "receipt:seen": {
    const input = z.object({ dir: z.string().min(1) }).safeParse(readStdin());
    if (!input.success) fail("receipt:seen input invalid", input.error.issues);

    // A fresh chain has no receipts, and that is the genesis case rather than an error:
    // nothing has executed, so there is no previous version to have changed from.
    const stored = readChain(resolve(process.cwd(), input.data.dir), {
      allowMissing: true,
    });

    // Parsed, not cast. `readChain` hands back a record for every file it found,
    // including ones it could not read, and reading `.outcome` off one of those would
    // take the process down at G1 — before the gate that exists to refuse cheaply ran.
    const lastExecuted = [...stored]
      .reverse()
      .map((entry) => receiptSchema.safeParse(entry.receipt))
      .find((parsed) => parsed.success && parsed.data.outcome === "executed");

    emit({
      ok: true,
      count: stored.length,
      seenStrategyHash:
        lastExecuted?.success === true ? lastExecuted.data.strategyHash : null,
      sequence: lastExecuted?.success === true ? lastExecuted.data.sequence : null,
    });
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
      "expected one of: envelope, compile, hash, preflight, balance, tx:status, " +
        "preset:check, review:enqueue, review:decision, receipt:append, receipt:seen, " +
        "receipt:verify",
    );
}
