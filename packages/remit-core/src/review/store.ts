/**
 * The review queue on disk.
 *
 * Two directories of JSON files: one pending item per proposal, one decision per answer.
 * The bridge writes items and waits; the console writes decisions. Nothing shared but a
 * filesystem, which means the console can be restarted, replaced by a CLI prompt (cut
 * line C3) or skipped entirely without the gate changing shape.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ReviewDecision,
  type ReviewItem,
  reviewDecisionSchema,
  reviewItemSchema,
} from "./schema.js";

const ITEMS = "pending";
const DECISIONS = "decisions";

export function enqueueReview(dir: string, item: ReviewItem): string {
  const parsed = reviewItemSchema.parse(item);
  const target = join(dir, ITEMS);
  mkdirSync(target, { recursive: true });
  const file = join(target, `${parsed.id}.json`);
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return file;
}

export function readPending(dir: string): readonly ReviewItem[] {
  const target = join(dir, ITEMS);
  if (!existsSync(target)) return [];

  return readdirSync(target)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      reviewItemSchema.parse(JSON.parse(readFileSync(join(target, name), "utf8"))),
    )
    .filter((item) => readDecision(dir, item.id) === undefined)
    .sort((a, b) => a.at - b.at);
}

export function readDecision(dir: string, id: string): ReviewDecision | undefined {
  const file = join(dir, DECISIONS, `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return reviewDecisionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export function decide(dir: string, decision: ReviewDecision): ReviewDecision {
  const parsed = reviewDecisionSchema.parse(decision);
  const target = join(dir, DECISIONS);
  mkdirSync(target, { recursive: true });
  const file = join(target, `${parsed.id}.json`);

  // First answer wins. A decision that can be overwritten is a decision nobody is
  // accountable for, and the receipt has already been written against it.
  if (existsSync(file)) {
    return reviewDecisionSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function readAllDecisions(dir: string): readonly ReviewDecision[] {
  const target = join(dir, DECISIONS);
  if (!existsSync(target)) return [];
  return readdirSync(target)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      reviewDecisionSchema.parse(JSON.parse(readFileSync(join(target, name), "utf8"))),
    )
    .sort((a, b) => a.at - b.at);
}
