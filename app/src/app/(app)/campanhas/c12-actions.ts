"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { emailSession } from "@/lib/email/session";
import { getT } from "@/lib/i18n/server";
import { ptMessages, type Messages } from "@/lib/i18n";

// C12 (0018): the owner approves each checklist item by hand with an evidence note. The database re-checks the role
// (approve_c12_item raises for anyone but an owner) and the note; this action only gives friendlier messages.

export type C12Item = keyof Messages["email"]["c12"]["items"];
// the item keys are the same in every language
const C12_ITEMS = Object.keys(ptMessages.email.c12.items) as [C12Item, ...C12Item[]];
const input = z.object({
  campaignId: z.string().uuid(),
  item: z.enum(C12_ITEMS),
  evidence: z.string().trim().min(3).max(300).regex(/^[^\r\n]*$/),
});

export type C12Result = { ok: boolean; message: string };

export async function approveC12Item(campaignId: string, item: C12Item, evidence: string): Promise<C12Result> {
  const t = await getT();
  const M = t.email.c12;
  const s = await emailSession();
  if (!s || s.workspace.role !== "owner") return { ok: false, message: M.ownerOnly };
  const parsed = input.safeParse({ campaignId, item, evidence });
  if (!parsed.success) return { ok: false, message: M.needEvidence };
  const { error } = await s.supabase.rpc("approve_c12_item", { p_workspace: s.workspace.id, p_item: parsed.data.item, p_evidence: parsed.data.evidence });
  revalidatePath(`/campanhas/${parsed.data.campaignId}`);
  if (error) return { ok: false, message: /owner/i.test(error.message) ? M.ownerOnly : /evidence/i.test(error.message) ? M.needEvidence : t.email.genericError };
  return { ok: true, message: M.saved };
}

/** Owner switch "relógio pode enviar de verdade" (0025 set_clock_real). The database re-checks owner (42501) and the C12 gate (23514). */
export async function setClockReal(campaignId: string, on: boolean): Promise<C12Result> {
  const t = await getT();
  const M = t.email.c12;
  const s = await emailSession();
  if (!s || s.workspace.role !== "owner") return { ok: false, message: M.ownerOnly };
  const parsed = z.object({ campaignId: z.string().uuid(), on: z.boolean() }).safeParse({ campaignId, on });
  if (!parsed.success) return { ok: false, message: t.email.genericError };
  const { error } = await s.supabase.rpc("set_clock_real", { p_ws: s.workspace.id, p_on: parsed.data.on });
  revalidatePath(`/campanhas/${parsed.data.campaignId}`);
  if (error) {
    if (error.code === "42501") return { ok: false, message: M.ownerOnly };
    if (error.code === "23514") return { ok: false, message: M.clock.needsC12Error };
    return { ok: false, message: t.email.genericError };
  }
  return { ok: true, message: parsed.data.on ? M.clock.savedOn : M.clock.savedOff };
}
