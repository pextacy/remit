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
import {
  AAVE_V3_POOL,
  limitsSchema,
  MODULE_PROXY_FACTORY,
  ROLES_MASTERCOPY,
  readChain,
  remitSchema,
  SAFE_L2_SINGLETON,
  SAFE_PROXY_FACTORY,
  USDC,
  verifyReceiptChain,
} from "@remit/core";
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

const readme = readIfPresent("README.md");
check(
  readme === undefined ? "blocked" : "ok",
  "README.md",
  readme === undefined ? "missing" : `${readme.split("\n").length} lines`,
);

const submission = readIfPresent("docs", "SUBMISSION.md");
const unfilled =
  submission === undefined ? [] : (submission.match(/\*\*\[fill\]\*\*|\[fill\]/g) ?? []);
check(
  submission === undefined ? "blocked" : unfilled.length === 0 ? "ok" : "human",
  "submission draft",
  submission === undefined
    ? "docs/SUBMISSION.md missing"
    : unfilled.length === 0
      ? "no unfilled fields"
      : `${unfilled.length} field(s) still marked [fill]`,
);

for (const doc of [
  "DEMO.md",
  "MAINNET.md",
  "VERIFIED.md",
  "OPEN_QUESTIONS.md",
  "phases.md",
]) {
  const content = readIfPresent("docs", doc);
  check(
    content === undefined ? "blocked" : "ok",
    `docs/${doc}`,
    content === undefined ? "missing" : "present",
  );
}

/**
 * Every address the code can reach must appear in docs/VERIFIED.md.
 *
 * The rule is "nothing unverified reaches a chain" (CLAUDE.md §2.2), and the way that
 * rots is a constant added in a hurry without its row. Comparing the two files is cheap
 * and catches exactly that.
 */
const verified = readIfPresent("docs", "VERIFIED.md") ?? "";
const addresses: readonly [string, string][] = [
  ["Roles mastercopy", ROLES_MASTERCOPY],
  ["ModuleProxyFactory", MODULE_PROXY_FACTORY],
  ["Safe L2 singleton", SAFE_L2_SINGLETON],
  ["Safe proxy factory", SAFE_PROXY_FACTORY],
  ["USDC on Base", USDC[8453]],
  ["USDC on Base Sepolia", USDC[84_532]],
  ["Aave pool on Base", AAVE_V3_POOL[8453]],
  ["Aave pool on Base Sepolia", AAVE_V3_POOL[84_532]],
];
const undocumented = addresses.filter(
  ([, address]) => !verified.toLowerCase().includes(address.toLowerCase()),
);
check(
  undocumented.length === 0 ? "ok" : "blocked",
  "every address is in VERIFIED.md",
  undocumented.length === 0
    ? `${addresses.length} checked`
    : undocumented.map(([name]) => name).join(", "),
);

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

function hasMainnetTransaction(): string | undefined {
  const dir = join(receiptsRoot, "base");
  if (!existsSync(dir)) return undefined;
  for (const entry of readChain(dir)) {
    const receipt = entry.receipt as { submission?: { txHash?: string | null } };
    const hash = receipt.submission?.txHash;
    if (typeof hash === "string") return hash;
  }
  return undefined;
}

const mainnetTx = hasMainnetTransaction();
check(
  mainnetTx === undefined ? "blocked" : "ok",
  "a Base mainnet transaction",
  mainnetTx ?? "none — the submission cannot be judged without one (OQ-9)",
);

const bountyIssue = readIfPresent("packages", "keeperhub-safe", "ISSUE.md");
check(
  bountyIssue === undefined ? "blocked" : "human",
  "the bounty issue",
  bountyIssue === undefined
    ? "no draft"
    : "drafted; filing it is a person's action (OQ-4)",
);

check(
  "human",
  "the demo video",
  "docs/DEMO.md is the script; recording it needs a screen (OQ-10)",
);
check(
  "human",
  "verified by somebody else",
  "remit verify from a clean clone, run by a person who did not write it (OQ-10)",
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
