"use server";

import { decide } from "@remit/core";
import { revalidatePath } from "next/cache";
import { REVIEW_ROOT } from "@/lib/paths";

/**
 * G3 — the one gate whose cost is a person's attention (G3-1, G3-3).
 *
 * A decision is written as a file the bridge is already polling for. Declining is not a
 * no-op: the bridge writes a terminal receipt with `outcome: "declined_g3"`, so a refusal
 * by a human sits in the same chain as a refusal by the chain.
 *
 * The first answer wins, in the store. A decision that can be overwritten is a decision
 * nobody is accountable for, and the receipt has already been written against it.
 */
export async function submitDecision(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const choice = String(formData.get("decision") ?? "");
  const by = String(formData.get("by") ?? "").trim() || "operator";
  const note = String(formData.get("note") ?? "").trim();

  if (id === "" || (choice !== "approved" && choice !== "declined")) return;

  decide(REVIEW_ROOT, {
    id,
    at: Math.floor(Date.now() / 1000),
    decision: choice,
    by,
    ...(note === "" ? {} : { note }),
  });

  revalidatePath("/review");
}
