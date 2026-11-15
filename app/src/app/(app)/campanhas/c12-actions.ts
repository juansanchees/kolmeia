"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { emailSession } from "@/lib/email/session";
import { t } from "@/messages/pt";

// C12 (0018): the owner approves each checklist item by hand with an evidence note. The database re-checks the role
// (approve_c12_item raises for anyone but an owner) and the note; this action only gives friendlier messages.

const M = t.email.c12;
export type C12Item = keyof typeof M.items;
const C12_ITEMS = Object.keys(M.items) as [C12Item, ...C12Item[]];
const input = z.object({
  campaignId: z.string().uuid(),
  item: z.enum(C12_ITEMS),
  evidence: z.string().trim().min(3).max(300).regex(/^[^\r\n]*$/),
});

export type C12Result = { ok: boolean; message: string };

export async function approveC12Item(campaignId: string, item: C12Item, evidence: string): Promise<C12Result> {
  const s = await emailSession();
  if (!s || s.workspace.role !== "owner") return { ok: false, message: M.ownerOnly };
  const parsed = input.safeParse({ campaignId, item, evidence });
  if (!parsed.success) return { ok: false, message: M.needEvidence };
  const { error } = await s.supabase.rpc("approve_c12_item", { p_workspace: s.workspace.id, p_item: parsed.data.item, p_evidence: parsed.data.evidence });
  revalidatePath(`/campanhas/${parsed.data.campaignId}`);
  if (error) return { ok: false, message: /owner/i.test(error.message) ? M.ownerOnly : /evidence/i.test(error.message) ? M.needEvidence : t.email.genericError };
  return { ok: true, message: M.saved };
}
