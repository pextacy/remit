/**
 * Friday morning, as a command.
 *
 *   pnpm --filter ops submit:check
 *
 * PLAN.md §11 is a checklist, and a checklist that a person ticks at 09:00 on the last
 * day is a checklist that gets ticked. This runs the half of it a machine can decide, and
 * says plainly which items are still a person's job.
 *
 * It reads and computes; it never fixes anything. An item that fails here is an item to
 * go and fix, not a flag to pass.
 *
 * Exit code 0 when everything checkable holds *and* nothing is outstanding; 1 when
 * something is blocking. Both are printed in full either way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { limitsSchema, readChain, remitSchema, verifyReceiptChain } from "@remit/core";
import { logEvent, say } from "../lib/log.js";
import { REPO } from "../lib/remit-file.js";

type Status = "ok" | "blocked" | "human";

type Item = {
  readonly status: Status;
  readonly label: string;
  readonly detail: string;
};

const items: Item[] = [];

function check(status: Status, label: string, detail: string): void {
  items.push({ status, label, detail });
}

function git(args: readonly string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Housekeeping: the items that invalidate a submission rather than weaken it
// ---------------------------------------------------------------------------

const tracked = git(["ls-files"]).split("\n");
/**
 * Any `.env`, at any depth — not only the one at the root.
 *
 * The console reads a `.env` of its own in `packages/remit-console/`, because Next loads
 * one from the directory it runs in rather than from the repository root. A second place
 * a secret can live is a second place it can be committed from, and `tracked.includes(".env")`
 * saw only the first.
 */
const trackedEnv = tracked.filter(
  (path) => /(^|\/)\.env($|\.)/.test(path) && !/(^|\/)\.env\.example$/.test(path),
);
check(
  trackedEnv.length === 0 ? "ok" : "blocked",
  "no .env tracked",
  trackedEnv.length === 0 ? "clean" : `${trackedEnv.join(", ")} in the index`,
);

/**
 * The whole history, not the working tree.
 *
 * A key removed in a later commit is still a key anyone can `git log -p` out of the
 * repository, and "we deleted it" is not a remediation — it is a disclosure. This is the
 * 08:30 item in PLAN.md §8 and it is the one worth running slowly.
 */
const history = git(["log", "-p", "--all"]);
const secretPatterns: readonly [string, RegExp][] = [
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["KeeperHub API key", /\bkh_[A-Za-z0-9]{16,}/],
  [
    "a 32-byte key assigned to a secret-looking name",
    /(PRIVATE_KEY|MNEMONIC|SEED_PHRASE)[A-Z_]*["']?\s*[:=]\s*["']?0x[a-fA-F0-9]{64}/,
  ],
  ["an .env file's contents", /^\+[A-Z_]{4,}=[A-Za-z0-9_\-/+]{20,}$/m],
];

const found = secretPatterns.filter(([, pattern]) => pattern.test(history));
check(
  found.length === 0 ? "ok" : "blocked",
  "no secret in git history",
  found.length === 0
    ? `${history.split("\n").length.toLocaleString()} lines of history scanned`
    : found.map(([name]) => name).join(", "),
);

const dirty = git(["status", "--porcelain"]).trim();
check(
  dirty === "" ? "ok" : "blocked",
  "working tree clean",
  dirty === ""
    ? "nothing uncommitted"
    : `${dirty.split("\n").length} uncommitted change(s)`,
);

/**
 * The quality gates, actually run.
 *
 * docs/CLAUDE.md §7 defines done as
 * `pnpm -r type-check && pnpm -r lint && pnpm -r test` passing, **and** `pytest` passing.
 * Friday morning is exactly when somebody wants to know that without going to look.
 *
 * It said "the four quality gates" and ran three — type-check and the two linters. The
 * two it left out were the tests, which are the only ones that would notice a gate that
 * had stopped refusing: a G1 with its recipient check deleted type-checks, lints, and
 * passes both linters. So this could report a submission ready with the product broken,
 * which is the one answer it exists to get right.
 *
 * The extra seconds are worth it. `maxBuffer` is raised because a test run prints a line
 * per test, and a gate that "failed" because its own output was too long would be a
 * false alarm on the morning this is read.
 */
function gate(label: string, command: string, args: readonly string[], cwd = REPO): void {
  try {
    execFileSync(command, args, {
      cwd,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    check("ok", label, "passes");
  } catch (error) {
    const output = String((error as { stdout?: string }).stdout ?? error);
    check("blocked", label, firstFailure(output));
  }
}

/**
 * The line worth showing out of a failed gate's output.
 *
 * `find(/error|Error|FAIL/)` matched the first line containing the word, which in a test
 * run is a *passing* test whose name happens to contain it — "✔ the error names the path
 * that failed". So the one line an operator reads on Friday morning pointed at something
 * that had worked.
 *
 * Failures are marked, and the markers differ per tool: TAP writes `not ok`, node:test
 * writes `✖`, tsc writes `error TS`, biome writes `×`. Pass markers are stripped first,
 * because they are what the word-match kept tripping over.
 */
function firstFailure(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(✔|ok\s|✓)/.test(line) && !/\s✔\s/.test(line));

  const marked = lines.find((line) => /(^not ok\b|✖|×|error TS|\bFAIL\b)/.test(line));
  if (marked !== undefined) return marked.slice(0, 120);

  // Nothing marked itself. The first line is more use than "failed" — it is usually the
  // command's own first word about what went wrong.
  return lines[0]?.slice(0, 120) ?? "failed, with no output";
}

gate("type-check", "pnpm", ["-r", "--if-present", "type-check"]);
gate("lint", "pnpm", ["exec", "biome", "check", "."]);
gate(
  "python lint",
  "uv",
  ["run", "ruff", "check", "."],
  join(REPO, "packages", "remit-bridge"),
);
// The gates, the hashes and the receipt chain, as unit tests. No chain and no clock, so
// they cost seconds — and they are what distinguishes "it compiles" from "it refuses".
gate("tests", "pnpm", ["-r", "--if-present", "test"]);
gate(
  "python tests",
  "uv",
  ["run", "pytest", "tests", "-q"],
  join(REPO, "packages", "remit-bridge"),
);

// ---------------------------------------------------------------------------
// The artefacts a judge opens
// ---------------------------------------------------------------------------

function readIfPresent(...parts: string[]): string | undefined {
  const path = join(REPO, ...parts);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * The documents that were kept.
 *
 * README.md, docs/SUBMISSION.md, DEMO.md, MAINNET.md, OPEN_QUESTIONS.md, phases.md and
 * the package READMEs were deleted on purpose (3eeaf55): four documents stay, the rest
 * was prose about a build that is now readable in the code. So this no longer asks for
 * files nobody intends to write again — it asks that the four kept ones are still there,
 * because they are what a reader is pointed at.
 */
for (const doc of ["CLAUDE.md", "DOCS.md", "PRD.md", "PLAN.md"]) {
  const content = readIfPresent("docs", doc);
  check(
    content === undefined ? "blocked" : "ok",
    `docs/${doc}`,
    content === undefined ? "missing" : `${content.split("\n").length} lines`,
  );
}

/**
 * Every address the code can reach, re-derived from the chains themselves.
 *
 * The rule is "nothing unverified reaches a chain" (CLAUDE.md §2.2), and it used to be
 * checked by looking the eight constants up in docs/VERIFIED.md — a table recording
 * where each came from and when somebody last looked. That document is gone, and the
 * table was the weaker fact in any case: it says a person checked once, not that the
 * chain still agrees. `verify:constants` reads all of them back off Base and Base
 * Sepolia and exits non-zero on a disagreement *or* on a read that never answered, which
 * is the same standard with the remembering taken out of it.
 *
 * It needs the network. That is the point: an endpoint that will not answer leaves a
 * constant unverified, and this is the morning to find that out.
 */
gate("constants agree with chain", "pnpm", [
  "--filter",
  "@remit/core",
  "verify:constants",
]);

// ---------------------------------------------------------------------------
// The receipts — the thing a stranger is asked to verify
// ---------------------------------------------------------------------------

const receiptsRoot = join(REPO, "receipts");
const chains = existsSync(receiptsRoot)
  ? readdirSync(receiptsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        readdirSync(join(receiptsRoot, name)).some((file) =>
          /^\d{4}-.+\.json$/.test(file),
        ),
      )
  : [];

/** Does git ignore this path? Asked rather than assumed from the directory's name. */
function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: REPO, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const committedChains = chains.filter((name) =>
  tracked.some((file) => file.startsWith(`receipts/${name}/`)),
);

if (committedChains.length === 0) {
  /**
   * "Not in the index" and "ignored" are different problems with different fixes.
   *
   * This said `gitignored` for every uncommitted chain, which sends an operator to
   * `.gitignore` when the answer is `git add`. The fork chains really are ignored — they
   * are regenerated on every run and are not evidence — but a real network's chain is
   * not, and the first time one existed this told them to go and look at the wrong file.
   */
  const ignored = chains.filter((name) => isIgnored(`receipts/${name}`));
  const stageable = chains.filter((name) => !isIgnored(`receipts/${name}`));

  check(
    "blocked",
    "a committed receipt chain",
    chains.length === 0
      ? "no receipts at all"
      : stageable.length > 0
        ? `${stageable.join(", ")} is on disk and not committed — ` +
          `\`git add receipts/${stageable[0]}\`. A chain nobody can clone is not evidence`
        : `${ignored.join(", ")} exist but are gitignored — a rehearsal chain is ` +
          "not evidence",
  );
} else {
  for (const name of committedChains) {
    const dir = join(receiptsRoot, name);
    let documents: { remit: unknown; limits: unknown } | undefined;
    const bundleRaw = readIfPresent("ops", "remits", `${name}.json`);
    if (bundleRaw !== undefined) {
      const parsed = JSON.parse(bundleRaw) as { remit: unknown; limits: unknown };
      documents = {
        remit: remitSchema.parse(parsed.remit),
        limits: limitsSchema.parse(parsed.limits),
      };
    }
    const verification = verifyReceiptChain(readChain(dir), documents);
    check(
      verification.ok ? "ok" : "blocked",
      `receipts/${name} verifies`,
      verification.ok
        ? `${verification.count} receipt(s)${documents === undefined ? ", without the documents" : ", with the documents"}`
        : `${verification.problems.length} problem(s)`,
    );
  }
}

// ---------------------------------------------------------------------------
// The three links the form will not accept as blank
// ---------------------------------------------------------------------------

/** The first transaction hash a chain's receipts carry, if any of them do. */
function firstTxHash(network: string): string | undefined {
  const dir = join(receiptsRoot, network);
  if (!existsSync(dir)) return undefined;
  for (const entry of readChain(dir)) {
    const receipt = entry.receipt as { submission?: { txHash?: string | null } };
    const hash = receipt.submission?.txHash;
    if (typeof hash === "string") return hash;
  }
  return undefined;
}

/**
 * A transaction on a public chain — not, specifically, on mainnet.
 *
 * This blocked until `receipts/base` carried one. The published rules ask for a working
 * demo on a public network and a verifiable deployment; they do not ask for mainnet. So
 * a Base Sepolia transaction satisfies the requirement, and demanding mainnet would have
 * blocked a submission that is complete — while quietly pushing whoever read it towards
 * spending real money to clear a check that was never asked for.
 *
 * Mainnet is still reported when it is there, because it is the stronger claim of the
 * two and worth naming.
 */
const publicTx = committedChains
  .filter((name) => name !== "anvil" && !name.startsWith("anvil-"))
  .map((name) => [name, firstTxHash(name)] as const)
  .find(([, hash]) => hash !== undefined);

check(
  publicTx === undefined ? "blocked" : "ok",
  "a transaction on a public chain",
  publicTx === undefined
    ? "none — a judge has nothing to look up"
    : `${publicTx[0]} ${publicTx[1]}`,
);

const mainnetTx = firstTxHash("base");
check(
  "ok",
  "a Base mainnet transaction",
  mainnetTx ?? "none — not required by the rules, and not claimed anywhere",
);

/**
 * The bounty contribution is code, and the code is here.
 *
 * This looked for `packages/keeperhub-safe/ISSUE.md`, a drafted issue body, and blocked
 * when it was missing. The draft went with the other prose; the action it describes did
 * not. Checking that the action exists is checking the contribution — a body text is
 * something a person writes into a form, which is what the item says.
 */
const bountyAction = readIfPresent("packages", "keeperhub-safe", "index.action.ts");
check(
  bountyAction === undefined ? "blocked" : "human",
  "the bounty contribution",
  bountyAction === undefined
    ? "packages/keeperhub-safe/index.action.ts missing"
    : "the action and its steps are in the repository; filing it is a person's action",
);

check("human", "the demo video", "recording it needs a screen");
check(
  "human",
  "verified by somebody else",
  "remit verify from a clean clone, run by a person who did not write it",
);
check(
  "human",
  "contact details",
  "an email plus an X or Discord handle, both actually monitored",
);
check("human", "eligibility", "18+, not resident in an OFAC-restricted jurisdiction");

// ---------------------------------------------------------------------------

const width = Math.max(...items.map((item) => item.label.length)) + 2;
const mark: Record<Status, string> = { ok: "ok  ", blocked: "NO  ", human: "··  " };

say("Submission checklist — PLAN.md §11, the half a machine can decide");
say("");
for (const item of items) {
  say(`${mark[item.status]} ${item.label.padEnd(width)} ${item.detail}`);
}

const blocked = items.filter((item) => item.status === "blocked");
const human = items.filter((item) => item.status === "human");

say("");
say(
  `${items.filter((i) => i.status === "ok").length} checked, ${blocked.length} blocking, ${human.length} waiting on a person`,
);

if (blocked.length > 0) {
  say("");
  say("Blocking — do not submit until these are true:");
  for (const item of blocked) say(`  - ${item.label}: ${item.detail}`);
}

if (human.length > 0) {
  say("");
  say("A person's, not a machine's:");
  for (const item of human) say(`  - ${item.label}: ${item.detail}`);
}

logEvent("submit.check", {
  ok: items.filter((i) => i.status === "ok").length,
  blocked: blocked.map((item) => item.label),
  human: human.map((item) => item.label),
});

process.exit(blocked.length === 0 ? 0 : 1);
