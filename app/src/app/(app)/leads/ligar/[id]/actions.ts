"use server";

import { revalidatePath } from "next/cache";
import { callBackAt, contactSchema, type ContactOutcome } from "@/lib/calls/call-input";
import { agentOfToday, nextInList } from "@/lib/calls/call-queries";
import type { FormState } from "@/lib/form-state";
import type { LeadStatus } from "@/lib/leads/types";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

type Input = { leadId: string; outcome: ContactOutcome; note: string; callBackOn: string | null };

/**
 * Records one contact ("Registrar contato"): log_call decides who may, the lead's new status, first/last contact
 * (0027 trigger) and the callback task. Returns the new status and the next lead of today's call list.
 */
export async function recordContactAction(input: Input): Promise<FormState & { status_after?: LeadStatus; next?: string | null }> {
  const t = await getT();
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: t.calls.errors.invalid };
  const d = parsed.data;
  const nextAt = d.outcome === "talked" && d.callBackOn ? callBackAt(d.callBackOn) : null;
  if (d.outcome === "talked" && !nextAt) return { status: "error", message: t.calls.errors.badDate };
  const user = await getUser();
  const supabase = await createClient();
  if (!user || !supabase) return { status: "error", message: t.calls.errors.failed };
  // The agent comes from the server's own view of today's list, not from the form.
  const agentId = (await agentOfToday(supabase, user.id, d.leadId)) ?? null;
  const { data, error } = await supabase.rpc("log_call", {
    p_lead: d.leadId,
    p_agent: agentId,
    p_outcome: d.outcome,
    p_spoke_to: "",
    p_notes: d.note,
    p_next_step: d.outcome === "talked" ? d.note.slice(0, 200) : "", // the callback task's title (tasks.title <= 200)
    p_next_step_at: nextAt,
  });
  if (error) {
    const msg =
      error.code === "55000" ? t.calls.errors.noPhone
      : error.code === "42501" ? t.calls.errors.denied
      : error.code === "22023" && nextAt ? t.calls.errors.dateRange // next step date out of range
      : t.calls.errors.failed;
    return { status: "error", message: msg };
  }
  revalidatePath("/leads/ligar");
  revalidatePath("/leads");
  revalidatePath("/leads/tarefas"); // "Ligar depois" became a task (0027)
  revalidatePath("/inicio"); // the called lead leaves "Ligar primeiro" and the next one comes in
  return { status: "success", status_after: data as LeadStatus, next: await nextInList(supabase, user.id, d.leadId) };
}
