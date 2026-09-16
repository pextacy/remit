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
  reviewIdSchema,
  reviewItemSchema,
} from "./schema.js";

const ITEMS = "pending";
const DECISIONS = "decisions";

/**
 * An id, checked again immediately before it becomes a path.
 *
 * The schemas already constrain it, but every one of these functions is reachable from a
 * caller that did not go through a schema — a server action reading a form field is the
 * obvious one — and a traversal here writes a file anywhere the console's user can write.
 * Two lines at the boundary are cheaper than trusting every caller forever.
 */
function fileFor(dir: string, id: string): string {
  const checked = reviewIdSchema.safeParse(id);
  if (!checked.success) {
    throw new Error(`refusing to use "${id}" as a review id: it is not one`);
  }
  return join(dir, `${checked.data}.json`);
}

export function enqueueReview(dir: string, item: ReviewItem): string {
  const parsed = reviewItemSchema.parse(item);
  const target = join(dir, ITEMS);
  const file = fileFor(target, parsed.id);
  mkdirSync(target, { recursive: true });
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return file;
}

/**
 * Everything still waiting for an answer.
 *
 * A file that is not a review item is skipped rather than thrown on. This is read by a
 * server component, and `parse` meant one malformed file took the whole review screen to
 * an error boundary — which is the screen an operator opens *because* something is
 * waiting. The receipt reader has been defensive about the same hazard all along; this
 * was not, and the two should not disagree about how a bad file is handled.
 *
 * Nothing is lost by skipping: the bridge that queued the item treats no decision as no
 * decision, and refuses when its deadline passes.
 */
export function readPending(dir: string): readonly ReviewItem[] {
  return readItems(dir).items.filter((item) => readDecision(dir, item.id) === undefined);
}

export type ReviewQueue = {
  readonly items: readonly ReviewItem[];
  /** Files in the queue directory that are not review items. Shown, not swallowed. */
  readonly unreadable: readonly string[];
};

export function readItems(dir: string): ReviewQueue {
  const target = join(dir, ITEMS);
  if (!existsSync(target)) return { items: [], unreadable: [] };

  const items: ReviewItem[] = [];
  const unreadable: string[] = [];

  for (const name of readdirSync(target).filter((file) => file.endsWith(".json"))) {
    try {
      items.push(
        reviewItemSchema.parse(JSON.parse(readFileSync(join(target, name), "utf8"))),
      );
    } catch {
      unreadable.push(name);
    }
  }

  return { items: items.sort((a, b) => a.at - b.at), unreadable };
}

export function readDecision(dir: string, id: string): ReviewDecision | undefined {
  const checked = reviewIdSchema.safeParse(id);
  if (!checked.success) return undefined;
  const file = fileFor(join(dir, DECISIONS), checked.data);
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
  const file = fileFor(target, parsed.id);
  mkdirSync(target, { recursive: true });

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

  const decisions: ReviewDecision[] = [];
  for (const name of readdirSync(target).filter((file) => file.endsWith(".json"))) {
    try {
      decisions.push(
        reviewDecisionSchema.parse(JSON.parse(readFileSync(join(target, name), "utf8"))),
      );
    } catch {
      // Skipped, like a malformed pending item. A decision that cannot be read is not a
      // decision, and `readDecision` already answers "none" for the same file — so the
      // item it belongs to stays in the queue rather than vanishing from both lists.
    }
  }

  return decisions.sort((a, b) => a.at - b.at);
}
