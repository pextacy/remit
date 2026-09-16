"use server";

import { decide, reviewIdSchema } from "@remit/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { checkOperator } from "@/lib/operator";
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
 *
 * A refusal here goes back to the screen with its reason rather than being dropped. A
 * reviewer whose click does nothing clicks again, and the chain would then show a review
 * nobody answered — which is the one thing this gate may not produce quietly.
 */
export async function submitDecision(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const choice = String(formData.get("decision") ?? "");
  const by = String(formData.get("by") ?? "").trim() || "operator";
  const note = String(formData.get("note") ?? "").trim();

  // Who is answering, before what they answered. This action is reachable by anything
  // that can reach the port — a server action is a public endpoint whatever the page
  // around it looks like — and an approval written by a stranger is the whole of G3.
  const operator = await checkOperator(String(formData.get("token") ?? ""));
  if (!operator.ok) refuse(operator.reason);

  if (choice !== "approved" && choice !== "declined") {
    refuse("a decision is either approved or declined, and this was neither");
  }

  // The id arrives as a form field and becomes a filename. Anything that is not a review
  // id is a write somewhere nobody asked for, so it is checked here as well as in the
  // store — two lines at the boundary are cheaper than trusting every caller forever.
  const checked = reviewIdSchema.safeParse(id);
  if (!checked.success) refuse(`"${id}" is not a review id — nothing was written`);

  decide(REVIEW_ROOT, {
    id: checked.data,
    at: Math.floor(Date.now() / 1000),
    decision: choice,
    by,
    ...(note === "" ? {} : { note }),
  });

  revalidatePath("/review");
}

function refuse(reason: string): never {
  redirect(`/review?refused=${encodeURIComponent(reason)}`);
}
