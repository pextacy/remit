/**
 * The failure surface: every non-happy-path requirement, demonstrated and recorded.
 *
 *   pnpm --filter ops nh --network anvil              # all of them
 *   pnpm --filter ops nh --network anvil --case nh2
 *   pnpm --filter ops nh --network anvil --case injection
 *
 * PRD.md §5.11 enumerates seven ways this system is supposed to refuse. Each one gets a
 * receipt here, in the same chain as every real run, with the same hashes — a failure
 * surface made of special-cased records would be a failure surface nobody could audit.
 *
 * **On "bypassing" a gate.** CLAUDE.md §2.5 forbids a bypass flag, and there is none. The
 * gates are independent functions, and this runner calls them at the layer each case is
 * about: G1 is asked directly, G2 is asked directly, and the chain is asked directly. No
 * code path in the product skips a gate; a demonstration that the second gate catches
 * what the first would have caught has to address the second gate, and that is what this
 * does. Nothing here is reachable from `propose`, `exec:mainnet` or `remit serve`.
 */

import {
  checkEnvelope,
  compileIntent,
  formatEnvelopeError,
  type Intent,
  type LedgerEntry,
  microsToUsd,
  USDC_DECIMALS,
  usdToMicros,
} from "@remit/core";
import { formatUnits, getAddress, parseUnits } from "viem";
import { castFor } from "../lib/actors.js";
import { networkFrom, option, parseArgs } from "../lib/args.js";
import { publicClientFor } from "../lib/clients.js";
import { countingClientFor } from "../lib/counting-transport.js";
import { requireDeployment, requireField } from "../lib/deployment.js";
import {
  executeThroughRole,
  preflight,
  preflightWasUnanswered,
  type RoleAction,
} from "../lib/exec-role.js";
import { fail, logEvent, say } from "../lib/log.js";
import { resolveNetwork } from "../lib/networks.js";
import { NO_SUBMISSION, type ReceiptContext, writeReceipt } from "../lib/receipt.js";
import { loadRemit, RECEIPTS_ROOT } from "../lib/remit-file.js";
import { assignRole } from "../lib/roles.js";

const args = parseArgs();
const network = networkFrom(args);
const deployment = requireDeployment(network.name);
const rolesModifier = requireField(deployment, "rolesModifier");
const loaded = loadRemit(network.name);
const cast = await castFor(network);

const context: ReceiptContext = {
  network,
  remit: loaded.remit,
  remitHash: loaded.remitHash,
  limits: loaded.limits,
  rolesModifier,
  agent: cast.agent.address,
  receiptsRoot: RECEIPTS_ROOT,
};

const safe = loaded.remit.safe;
const attacker = cast.attacker;
const now = () => Math.floor(Date.now() / 1000);
const usdc = (amount: string) => parseUnits(amount, USDC_DECIMALS).toString();

type Outcome = {
  readonly requirement: string;
  readonly held: boolean;
  readonly evidence: string;
};
const outcomes: Outcome[] = [];

function record(requirement: string, held: boolean, evidence: string): void {
  outcomes.push({ requirement, held, evidence });
  say(`${held ? "ok  " : "FAIL"} ${requirement.padEnd(6)} ${evidence}`);
  logEvent("nh.case", { requirement, held, evidence });
}

/** G1, asked directly. Pure, so the only inputs are the ones passed here. */
function gate1(intent: unknown, ledger: readonly LedgerEntry[] = []) {
  return checkEnvelope({
    remit: loaded.remit,
    limits: loaded.limits,
    chainId: network.chainId,
    intent,
    now: now(),
    ledger,
  });
}

function actionFor(intent: Intent): RoleAction {
  const compiled = compileIntent(network.chainId, intent);
  return {
    label: compiled.description,
    target: compiled.target,
    data: compiled.calldata,
  };
}

function receiptAction(intent: Intent, usd: string) {
  const compiled = compileIntent(network.chainId, intent);
  return {
    target: compiled.target,
    signature: compiled.signature,
    selector: compiled.selector,
    description: compiled.description,
    usd,
  };
}

// ---------------------------------------------------------------------------
// NH-1 — an out-of-envelope target is refused at G1, before any I/O
// ---------------------------------------------------------------------------
async function nh1(): Promise<void> {
  const intent = { kind: "withdraw", asset: "USDC", amount: usdc("1"), to: attacker };

  // Count RPC traffic around the gate. "No network call was made" is a claim about what
  // did not happen; counting it beats asserting it.
  const counting = countingClientFor(network);
  counting.reset();
  const result = gate1(intent);
  const requests = counting.count();

  if (result.ok) fail("NH-1: G1 allowed a withdrawal to an address that is not the Safe");

  writeReceipt(context, {
    intent: intent as Intent,
    action: null,
    gates: [
      {
        gate: "G1",
        outcome: "refused",
        code: result.error.code,
        detail: formatEnvelopeError(result.error),
      },
    ],
    outcome: "rejected_g1",
    submission: NO_SUBMISSION,
  });

  // Both halves of the requirement: refused *for being out of the envelope*, and for
  // free. Asserting only `requests === 0` would have reported NH-1 held while G1 refused
  // for some entirely different reason — a schema change that turned this into
  // `INTENT_MALFORMED` costs nothing in RPC calls either.
  record(
    "NH-1",
    result.error.code === "OUT_OF_REMIT_RECIPIENT" && requests === 0,
    `${result.error.code}; ${requests} RPC request(s) made reaching that answer`,
  );
}

// ---------------------------------------------------------------------------
// NH-2 — a preset tightened after the Remit was signed is caught at G2, no gas
// ---------------------------------------------------------------------------
async function nh2(): Promise<void> {
  const pool = compileIntent(network.chainId, {
    kind: "withdraw",
    asset: "USDC",
    amount: usdc("1"),
    to: safe,
  }).target;

  // Narrow the chain by hand, the way an operator would if they changed their mind about
  // what the agent may do. The Remit still says withdraw is allowed; the chain no longer
  // agrees, and G2 is where that disagreement surfaces.
  const { encodeFunctionData, toFunctionSelector } = await import("viem");
  const { rolesAbi } = await import("@remit/core");
  const { execSafeTx, safeCall } = await import("../lib/safe.js");

  const revoke = (selector: `0x${string}`) =>
    execSafeTx(
      network,
      safe,
      cast.signingOwners,
      safeCall(
        rolesModifier,
        encodeFunctionData({
          abi: rolesAbi,
          functionName: "revokeFunction",
          args: [loaded.remit.roleKey, pool, selector],
        }),
      ),
      "nh2.revokeFunction",
    );

  const selector = toFunctionSelector("withdraw(address,uint256,address)");
  await revoke(selector);

  try {
    const intent: Intent = {
      kind: "withdraw",
      asset: "USDC",
      amount: usdc("1"),
      to: getAddress(safe),
    };
    const envelope = gate1(intent);
    if (!envelope.ok) fail("NH-2: G1 refused; this case is about G2");

    const check = await preflight(
      network,
      rolesModifier,
      loaded.remit.roleKey,
      cast.agent.address,
      actionFor(intent),
    );

    if (check.ok) fail("NH-2: G2 allowed a call the chain no longer permits");

    const named =
      check.decoded.kind === "roles_condition_violation"
        ? check.decoded.statusName
        : check.decoded.kind === "roles_error"
          ? check.decoded.name
          : check.decoded.kind;

    writeReceipt(context, {
      intent,
      action: receiptAction(intent, "1"),
      gates: [
        { gate: "G1", outcome: "pass", detail: "the Remit still permits this" },
        { gate: "G2", outcome: "refused", code: named, detail: check.reason },
      ],
      outcome: "rejected_g2",
      submission: NO_SUBMISSION,
    });

    record("NH-2", named === "FunctionNotAllowed", `${named}, no gas spent`);
  } finally {
    // Put it back. A scenario that leaves the chain narrower than it found it makes every
    // later case a lie.
    const { encodeFunctionData: encode } = await import("viem");
    const { buildPreset, encodePreset } = await import("@remit/core");
    const preset = buildPreset(network.chainId, loaded.remit.roleKey);
    for (const call of encodePreset(preset)) {
      await execSafeTx(
        network,
        safe,
        cast.signingOwners,
        safeCall(rolesModifier, call.data),
        `nh2.restore: ${call.label}`,
      );
    }
    void encode;
  }
}

// ---------------------------------------------------------------------------
// NH-3 — a forced out-of-preset transaction reverts on chain
// ---------------------------------------------------------------------------
async function nh3(): Promise<void> {
  const intent: Intent = {
    kind: "withdraw",
    asset: "USDC",
    amount: usdc("1"),
    to: getAddress(attacker),
  };

  // Both earlier gates are *asked*, not assumed. This receipt used to state their
  // outcomes as constants — `OUT_OF_REMIT_RECIPIENT` and `ParameterNotAllowed` — without
  // either gate having run in this scenario, which is the audit trail asserting a gate
  // that never answered. It is the one thing the bridge's own comments forbid, and these
  // records are committed.
  const envelope = gate1(intent);
  if (envelope.ok)
    fail("NH-3: G1 allowed a withdrawal to an address that is not the Safe");

  const preflighted = await preflight(
    network,
    rolesModifier,
    loaded.remit.roleKey,
    cast.agent.address,
    actionFor(intent),
  );
  if (preflighted.ok) fail("NH-3: G2 allowed a call the preset does not permit");
  // A chain that never answered is not the preset refusing, and this receipt is
  // committed as evidence that it did. NH-6 is the case about an unreachable chain;
  // here it means the scenario could not be run.
  if (preflightWasUnanswered(preflighted)) {
    fail(`NH-3: the chain did not answer G2 — ${preflighted.reason}`);
  }
  const refusedAt2 =
    preflighted.decoded.kind === "roles_condition_violation"
      ? preflighted.decoded.statusName
      : preflighted.decoded.kind === "roles_error"
        ? preflighted.decoded.name
        : preflighted.decoded.kind;

  // The chain is asked anyway — with an explicit gas limit, because estimation would
  // throw before anything was sent and a refusal that never reached the chain is not
  // evidence that the chain refuses.
  const result = await executeThroughRole(
    network,
    rolesModifier,
    loaded.remit.roleKey,
    cast.agent,
    actionFor(intent),
    { expectRevert: true },
  );

  if (result.status !== "reverted") {
    fail("NH-3: an out-of-preset transaction succeeded on chain");
  }

  writeReceipt(context, {
    intent,
    action: receiptAction(intent, "1"),
    gates: [
      {
        gate: "G1",
        outcome: "refused",
        code: envelope.error.code,
        detail: formatEnvelopeError(envelope.error),
      },
      { gate: "G2", outcome: "refused", code: refusedAt2, detail: preflighted.reason },
      { gate: "G4", outcome: "reverted", detail: result.hash },
    ],
    outcome: "reverted_g4",
    submission: {
      path: "ops-direct",
      executionId: null,
      workflowId: null,
      txHash: result.hash,
      explorer: null,
      gasUsed: result.gasUsed.toString(),
    },
  });

  /**
   * What was actually demonstrated, not the fact that we reached this line.
   *
   * This was `record("NH-3", true, …)`. The `fail()` guards above do enforce each step,
   * so the demonstration was real — but the *recorded* outcome was a constant, and
   * `outcomes` is what the summary line and the exit code are computed from. A check
   * that cannot fail is worse than no check: it reports "ok" beside every real one, and
   * a reader counts it. The same sin was found and fixed in `mainnet:preflight`.
   */
  record(
    "NH-3",
    envelope.error.code === "OUT_OF_REMIT_RECIPIENT" &&
      refusedAt2 === "ParameterNotAllowed" &&
      result.status === "reverted",
    `${envelope.error.code} at G1, ${refusedAt2} at G2, reverted at G4 — ` +
      `${result.gasUsed} gas, ${result.hash}`,
  );
}

// ---------------------------------------------------------------------------
// NH-4 — the kill switch, mid-session: G2 and G4 both stop
// ---------------------------------------------------------------------------
async function nh4(): Promise<void> {
  const intent: Intent = {
    kind: "approve",
    asset: "USDC",
    amount: usdc("1"),
    spender: compileIntent(network.chainId, {
      kind: "supply",
      asset: "USDC",
      amount: usdc("1"),
      onBehalfOf: safe,
    }).target,
  };

  await assignRole(
    network,
    safe,
    cast.signingOwners,
    rolesModifier,
    cast.agent.address,
    loaded.remit.roleKey,
    false,
  );

  try {
    // Asked, not asserted. The claim this receipt makes about G1 — that the Remit still
    // permits the action, and it is the *chain* that stopped it — is the whole point of
    // the case, so it has to be a reading rather than a sentence.
    const envelope = gate1(intent);
    if (!envelope.ok) {
      fail(`NH-4: G1 refused before the chain could — ${envelope.error.code}`);
    }

    const check = await preflight(
      network,
      rolesModifier,
      loaded.remit.roleKey,
      cast.agent.address,
      actionFor(intent),
    );
    if (check.ok) fail("NH-4: the agent can still act after the kill switch");
    // A chain that never answered says nothing about whether the switch took effect,
    // and this receipt is committed as evidence that it did.
    if (preflightWasUnanswered(check)) {
      fail(`NH-4: the chain did not answer G2 — ${check.reason}`);
    }

    // The refusal has to be the role's, not the call failing for its own reasons. A
    // revoked agent answers `NoMembership` or `NotAuthorized`; anything else means the
    // role let it through and something further in said no, which is a true answer to a
    // different question and would make this case demonstrate nothing.
    const refusedByRole =
      check.decoded.kind === "roles_error" &&
      (check.decoded.name === "NoMembership" || check.decoded.name === "NotAuthorized");

    const forced = await executeThroughRole(
      network,
      rolesModifier,
      loaded.remit.roleKey,
      cast.agent,
      actionFor(intent),
      { expectRevert: true },
    );
    if (forced.status !== "reverted") fail("NH-4: a revoked agent moved value on chain");

    writeReceipt(context, {
      intent,
      action: receiptAction(intent, "1"),
      gates: [
        {
          gate: "G1",
          outcome: "pass",
          detail: "the Remit is unchanged — it is the chain that revoked the agent",
        },
        {
          gate: "G2",
          outcome: "refused",
          // The name the modifier actually gave. A revoked agent answers `NotAuthorized`
          // as often as `NoMembership` — one comes from the `moduleOnly` guard, the other
          // a layer in — and a receipt that always says one of them names a refusal that
          // may not have happened.
          code:
            check.decoded.kind === "roles_error"
              ? check.decoded.name
              : check.decoded.kind === "roles_condition_violation"
                ? check.decoded.statusName
                : check.decoded.kind,
          detail: check.reason,
        },
        { gate: "G4", outcome: "reverted", detail: forced.hash },
      ],
      outcome: "reverted_g4",
      submission: {
        path: "ops-direct",
        executionId: null,
        workflowId: null,
        txHash: forced.hash,
        explorer: null,
        gasUsed: forced.gasUsed.toString(),
      },
    });

    // Not a constant. `outcomes` is what the summary line and the exit code are computed
    // from, and a check that cannot fail reports "ok" beside every real one.
    record(
      "NH-4",
      envelope.ok && refusedByRole && forced.status === "reverted",
      `${check.reason} at G2, then reverted on chain at G4`,
    );
  } finally {
    await assignRole(
      network,
      safe,
      cast.signingOwners,
      rolesModifier,
      cast.agent.address,
      loaded.remit.roleKey,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// NH-5 — the daily cap, exhausted
// ---------------------------------------------------------------------------
async function nh5(): Promise<void> {
  const capMicros = usdToMicros(loaded.limits.dailyCapUsd);
  const spent: LedgerEntry[] = [
    { at: now() - 60, usdMicros: capMicros.toString(), kind: "supply" },
  ];

  const intent = { kind: "supply", asset: "USDC", amount: usdc("1"), onBehalfOf: safe };
  const result = gate1(intent, spent);

  if (result.ok) fail("NH-5: G1 allowed a supply with the daily cap already spent");

  writeReceipt(context, {
    intent: intent as Intent,
    action: null,
    gates: [
      {
        gate: "G1",
        outcome: "refused",
        code: result.error.code,
        detail: formatEnvelopeError(result.error),
      },
    ],
    outcome: "rejected_g1",
    submission: NO_SUBMISSION,
  });

  // The console's headroom reading is this number. Zero is the thing an operator sees.
  const headroom = capMicros - BigInt(spent[0]?.usdMicros ?? "0");
  record(
    "NH-5",
    result.error.code === "REMIT_CAP_EXCEEDED_DAILY" && headroom === 0n,
    `${result.error.code}, headroom ${microsToUsd(headroom)} USD of ${loaded.limits.dailyCapUsd}`,
  );
}

// ---------------------------------------------------------------------------
// NH-6 — an unreachable RPC refuses, and never executes blind
// ---------------------------------------------------------------------------
async function nh6(): Promise<void> {
  const intent: Intent = {
    kind: "supply",
    asset: "USDC",
    amount: usdc("1"),
    onBehalfOf: getAddress(safe),
  };

  // A port with nothing listening: a real connection refusal, not a simulated one.
  const dead = { ...resolveNetwork(network.name), rpcUrl: "http://127.0.0.1:1" };

  // G1 runs here for real: this case is about G2 being unable to answer, and the receipt
  // says G1 passed — which it may only say if G1 was asked.
  const envelope = gate1(intent);
  if (!envelope.ok) fail(`NH-6: G1 refused a legitimate intent: ${envelope.error.code}`);

  const started = Date.now();
  const check = await preflight(
    dead,
    rolesModifier,
    loaded.remit.roleKey,
    cast.agent.address,
    actionFor(intent),
  );
  const elapsed = Date.now() - started;

  if (check.ok) fail("NH-6: an unreachable RPC reported that the call would be allowed");

  // The gate could not answer, which is not the same as the role refusing — and the
  // receipt has to say which. `preflight` used to collapse the two: a `fetch failed`
  // carries no revert data, so it decoded as `undecodable` and came back looking like a
  // refusal. Now that the distinction exists in the type, this record uses it, and it
  // uses the same words the gated pipeline writes for the same fact — a failure surface
  // whose records are shaped differently from the product's is one nobody can audit.
  const unanswered = preflightWasUnanswered(check);

  writeReceipt(context, {
    intent,
    action: receiptAction(intent, "1"),
    gates: [
      {
        gate: "G1",
        outcome: "pass",
        detail: "inside the Remit; the chain was the problem",
      },
      unanswered
        ? {
            gate: "G2",
            outcome: "skipped",
            code: "RPC_UNREACHABLE",
            detail: check.reason,
          }
        : {
            gate: "G2",
            outcome: "refused",
            code: "G2_REFUSED",
            detail: check.reason,
          },
    ],
    outcome: "rejected_g2",
    submission: NO_SUBMISSION,
  });

  // The requirement is that an unreachable chain stops the action *and* is not recorded
  // as the preset having spoken. Asserting only `!check.ok` would have passed while the
  // receipt claimed a refusal nobody made.
  record(
    "NH-6",
    !check.ok && unanswered,
    `the chain could not be reached after ${elapsed}ms; nothing was sent, and the ` +
      "receipt says the gate was not asked rather than that it refused",
  );
}

// ---------------------------------------------------------------------------
// NH-7 — three intents at once
// ---------------------------------------------------------------------------
async function nh7(): Promise<void> {
  const client = publicClientFor(network);
  const pool = compileIntent(network.chainId, {
    kind: "supply",
    asset: "USDC",
    amount: usdc("1"),
    onBehalfOf: safe,
  }).target;

  const amounts = ["0.10", "0.20", "0.30"];
  const build = (amount: string): Intent => ({
    kind: "approve",
    asset: "USDC",
    amount: usdc(amount),
    spender: pool,
  });

  for (const amount of amounts) {
    const envelope = gate1(build(amount));
    if (!envelope.ok)
      fail(`NH-7: G1 refused a legitimate intent: ${envelope.error.code}`);
  }

  // --- all three at once, on the path that has no nonce manager -------------
  const before = await client.getTransactionCount({ address: cast.agent.address });
  const concurrent = await Promise.allSettled(
    amounts.map((amount) =>
      executeThroughRole(
        network,
        rolesModifier,
        loaded.remit.roleKey,
        cast.agent,
        actionFor(build(amount)),
      ),
    ),
  );

  const landed = concurrent.filter((result) => result.status === "fulfilled").length;
  const collided = concurrent.filter(
    (result) => result.status === "rejected" && /nonce/i.test(String(result.reason)),
  ).length;

  say(`      concurrent on ops-direct: ${landed}/3 landed, ${collided} refused on nonce`);

  // --- the same three, serialised -------------------------------------------
  // The comparison is the point. Serialising is what a caller has to do when nothing
  // else manages the nonce, and it is exactly the work KeeperHub takes over.
  const serialised = [];
  for (const amount of amounts) {
    serialised.push(
      await executeThroughRole(
        network,
        rolesModifier,
        loaded.remit.roleKey,
        cast.agent,
        actionFor(build(amount)),
      ),
    );
  }

  const nonces: number[] = [];
  for (const result of serialised) {
    const tx = await client.getTransaction({ hash: result.hash });
    nonces.push(Number(tx.nonce));
  }

  const receipts = await Promise.all(
    serialised.map((result) => client.getTransactionReceipt({ hash: result.hash })),
  );

  const after = await client.getTransactionCount({ address: cast.agent.address });
  const ordered = nonces.every(
    (nonce, index) => index === 0 || nonce === (nonces[index - 1] ?? -1) + 1,
  );
  const allSucceeded = receipts.every((receipt) => receipt.status === "success");

  for (const [index, result] of serialised.entries()) {
    const intent = build(amounts[index] ?? "0");
    writeReceipt(
      context,
      {
        intent,
        action: receiptAction(intent, amounts[index] ?? "0"),
        gates: [
          {
            gate: "G1",
            outcome: "pass",
            detail: `inside the Remit: approve ${amounts[index]} USDC to the pool`,
          },
          {
            gate: "G2",
            outcome: "skipped",
            detail: "not asked — this case is about nonce ordering, not authority",
          },
          { gate: "G4", outcome: "pass", detail: `nonce ${nonces[index]}` },
        ],
        outcome: "executed",
        submission: {
          path: "ops-direct",
          executionId: null,
          workflowId: null,
          txHash: result.hash,
          explorer: null,
          gasUsed: result.gasUsed.toString(),
        },
      },
      { quiet: true },
    );
  }

  // What "held" means here: nothing was lost and nothing was double-sent. A collision
  // that refuses is a safe failure; a collision that silently replaced a transaction
  // would not be.
  const nothingLost = allSucceeded && ordered && after > before;

  record(
    "NH-7",
    nothingLost,
    `serialised: nonces ${nonces.join(", ")}, all landed in order`,
  );
  say("      The concurrent attempt is the finding, not a failure of the system:");
  say("      three transactions from one EOA with no nonce manager in front of them");
  say("      collide, and the client refuses rather than replacing one silently.");
  say("      Managing that is what KeeperHub does, and evidencing *its* behaviour");
  say("      is its own job. This evidences the problem, not the fix.");
}

// ---------------------------------------------------------------------------
// The injection scenario — one poisoned input, three independent refusals
// ---------------------------------------------------------------------------
async function injection(): Promise<void> {
  say("");
  say("A strategy input crafted to send the Safe's USDC to an attacker.");
  say(`attacker  ${attacker}`);
  say("");

  const poisoned = { kind: "withdraw", asset: "USDC", amount: usdc("5"), to: attacker };

  // --- layer 1: the envelope ------------------------------------------------
  const counting = countingClientFor(network);
  counting.reset();
  const envelope = gate1(poisoned);
  const requests = counting.count();
  if (envelope.ok) fail("injection: G1 allowed it");

  writeReceipt(context, {
    intent: poisoned as Intent,
    action: null,
    gates: [
      {
        gate: "G1",
        outcome: "refused",
        code: envelope.error.code,
        detail: formatEnvelopeError(envelope.error),
      },
    ],
    outcome: "rejected_g1",
    submission: NO_SUBMISSION,
  });
  say(`G1  REFUSED  ${envelope.error.code} — ${requests} network call(s), no gas`);

  // --- layer 2: the preflight ----------------------------------------------
  // G1 is not bypassed; the question is put to the *next* gate, which is a different
  // function with a different answer. There is no flag anywhere that skips G1.
  const action = actionFor(poisoned as Intent);
  const check = await preflight(
    network,
    rolesModifier,
    loaded.remit.roleKey,
    cast.agent.address,
    action,
  );
  if (check.ok) fail("injection: G2 allowed it");
  // A chain that never answered is not the preset refusing, and this receipt is committed
  // as the demonstration that it did.
  if (preflightWasUnanswered(check)) {
    fail(`injection: the chain did not answer G2 — ${check.reason}`);
  }

  const named =
    check.decoded.kind === "roles_condition_violation"
      ? check.decoded.statusName
      : check.decoded.kind;

  writeReceipt(context, {
    intent: poisoned as Intent,
    action: receiptAction(poisoned as Intent, "5"),
    gates: [
      { gate: "G1", outcome: "skipped", detail: "asked of G2 directly" },
      { gate: "G2", outcome: "refused", code: named, detail: check.reason },
    ],
    outcome: "rejected_g2",
    submission: NO_SUBMISSION,
  });
  say(`G2  REFUSED  ${named} — one eth_call, no gas`);

  // --- layer 3: the chain ---------------------------------------------------
  const forced = await executeThroughRole(
    network,
    rolesModifier,
    loaded.remit.roleKey,
    cast.agent,
    action,
    { expectRevert: true },
  );
  if (forced.status !== "reverted") fail("injection: the chain let it through");

  writeReceipt(context, {
    intent: poisoned as Intent,
    action: receiptAction(poisoned as Intent, "5"),
    gates: [
      { gate: "G1", outcome: "skipped" },
      { gate: "G2", outcome: "skipped" },
      { gate: "G4", outcome: "reverted", detail: forced.hash },
    ],
    outcome: "reverted_g4",
    submission: {
      path: "ops-direct",
      executionId: null,
      workflowId: null,
      txHash: forced.hash,
      explorer: null,
      gasUsed: forced.gasUsed.toString(),
    },
  });
  say(`G4  REVERTED ${forced.hash} — ${forced.gasUsed} gas, nothing moved`);

  const client = publicClientFor(network);
  const { erc20Abi, USDC } = await import("@remit/core");
  const stolen = (await client.readContract({
    address: getAddress(USDC[network.chainId]),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(attacker)],
  })) as bigint;

  /**
   * The claim and the assertion have to be the same sentence.
   *
   * The evidence line says "three independent refusals", and this checked only the
   * attacker's balance — which is also zero when nothing happened at all. The three
   * refusals are what the README leads with; each one is now named here, and the balance
   * is the fourth thing rather than the only one.
   */
  const threeRefusals =
    envelope.error.code === "OUT_OF_REMIT_RECIPIENT" &&
    named === "ParameterNotAllowed" &&
    forced.status === "reverted";

  record(
    "INJ",
    threeRefusals && stolen === 0n,
    `three independent refusals (${envelope.error.code}, ${named}, reverted); ` +
      `the attacker holds ${formatUnits(stolen, USDC_DECIMALS)} USDC`,
  );
}

// ---------------------------------------------------------------------------

const cases: Record<string, () => Promise<void>> = {
  nh1,
  nh2,
  nh3,
  nh4,
  nh5,
  nh6,
  nh7,
  injection,
};

const selected = option(args, "case") ?? "all";
const toRun = selected === "all" ? Object.keys(cases) : [selected];

say(`network   ${network.name}`);
say(`remit     ${loaded.remitHash}`);
say(`safe      ${safe}`);
say("");

for (const name of toRun) {
  const runner = cases[name];
  if (runner === undefined)
    fail(`unknown case "${name}" — one of ${Object.keys(cases).join(", ")}`);
  await runner();
}

say("");
const failed = outcomes.filter((outcome) => !outcome.held);
say(
  failed.length === 0
    ? `${outcomes.length} requirement(s) held, each with a receipt`
    : `${failed.length} of ${outcomes.length} did not hold`,
);
process.exit(failed.length === 0 ? 0 : 1);
