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
check(
  tracked.includes(".env") ? "blocked" : "ok",
  "no .env tracked",
  tracked.includes(".env") ? ".env is in the index" : "clean",
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
 * The four quality gates, actually run.
 *
 * CLAUDE.md §7 says a task is done when these pass, and Friday morning is exactly when
 * somebody wants to know without going to look. Ten seconds is worth it.
 */
function gate(label: string, command: string, args: readonly string[], cwd = REPO): void {
  try {
    execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
    check("ok", label, "passes");
  } catch (error) {
    const output = String((error as { stdout?: string }).stdout ?? error);
    const firstError = output.split("\n").find((line) => /error|Error|FAIL/.test(line));
    check("blocked", label, firstError?.trim().slice(0, 100) ?? "failed");
  }
}

gate("type-check", "pnpm", ["-r", "--if-present", "type-check"]);
gate("lint", "pnpm", ["exec", "biome", "check", "."]);
gate(
  "python lint",
  "uv",
  ["run", "ruff", "check", "."],
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

const committedChains = chains.filter((name) =>
  tracked.some((file) => file.startsWith(`receipts/${name}/`)),
);

if (committedChains.length === 0) {
  check(
    "blocked",
    "a committed receipt chain",
    chains.length === 0
      ? "no receipts at all"
      : `${chains.join(", ")} exist but are gitignored — a rehearsal chain is not evidence`,
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
