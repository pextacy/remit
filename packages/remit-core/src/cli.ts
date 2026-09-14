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
import { z } from "zod";
import { canonicalJson } from "./canonical/json.js";
import { compileIntent } from "./compile/action.js";
import { remitDigest } from "./eip712/remit.js";
import { receiptBodySchema } from "./receipts/schema.js";
import { appendReceipt, verifyChainAt } from "./receipts/store.js";
import { intentSchema } from "./schema/intent.js";
import { limitsHash, limitsSchema } from "./schema/limits.js";
import { chainIdSchema } from "./schema/primitives.js";
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
    emit(out);
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
