"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/lib/form-state";
import { sanitizeUrl } from "@/lib/safe-url";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const H = t.handoff;
const id = z.string().uuid();
const fail = (message: string): FormState => ({ status: "error", message });
const ok = (message: string): FormState => ({ status: "success", message });

const briefSchema = z.object({
  who: z.string().trim().max(600),
  what_they_said: z.string().trim().max(800),
  next_step: z.string().trim().min(1).max(400),
  evidence_urls: z.array(z.string().max(2000)).max(4),
});

/** Passes a lead to a closer with a brief. Owner/sdr only (the SQL checks it again); model "manual" is set here. */
export async function handOffLeadAction(
  leadId: string,
  closerId: string,
  brief: { who: string; what_they_said: string; next_step: string; evidence_urls: string[] },
): Promise<FormState> {
  await requireSender();
  const parsedIds = z.object({ leadId: id, closerId: id }).safeParse({ leadId, closerId });
  if (!parsedIds.success) return fail(H.pickCloser);
  const b = briefSchema.safeParse(brief);
  if (!b.success) return fail(b.error.issues.some((i) => i.path[0] === "next_step") ? H.needNext : H.failed);
  const urls = [...new Set(b.data.evidence_urls.map((u) => sanitizeUrl(u)).filter((u): u is string => Boolean(u)))];
  const supabase = await createClient();
  if (!supabase) return fail(H.failed);
  const { error } = await supabase.rpc("hand_off_lead", {
    p_lead: parsedIds.data.leadId,
    p_closer: parsedIds.data.closerId,
    p_brief: { ...b.data, evidence_urls: urls, model: "manual" },
  });
  if (error) return fail(error.code === "55000" ? H.leadClosed : error.code === "22023" ? H.closerLeft : H.failed);
  revalidatePath("/leads", "layout");
  return ok(H.statusDone);
}

/** Won or lost. Any signed-in member: the RPC (sender, or the lead's closer) and RLS decide. */
export async function setLeadStatusAction(leadId: string, status: "won" | "lost"): Promise<FormState> {
  const parsed = z.object({ leadId: id, status: z.enum(["won", "lost"]) }).safeParse({ leadId, status });
  if (!parsed.success) return fail(H.failed);
  if (!(await getCurrentWorkspace())) return fail(H.failed);
  const supabase = await createClient();
  if (!supabase) return fail(H.failed);
  const { error } = await supabase.rpc("set_lead_status", { p_lead: parsed.data.leadId, p_status: parsed.data.status });
  if (error) return fail(H.failed);
  revalidatePath("/leads", "layout");
  return ok(H.statusDone);
}

/** Puts one lead on a call agent's list for today. Owner/sdr only. */
export async function addToCallListAction(leadId: string, agentId: string): Promise<FormState> {
  await requireSender();
  const parsed = z.object({ leadId: id, agentId: id }).safeParse({ leadId, agentId });
  if (!parsed.success) return fail(H.failed);
  const supabase = await createClient();
  if (!supabase) return fail(H.failed);
  const { error } = await supabase.rpc("add_to_call_list", { p_lead: parsed.data.leadId, p_agent: parsed.data.agentId });
  if (error) return fail(H.failed);
  revalidatePath("/leads", "layout");
  return ok(H.added);
}
