"use server";

import { revalidatePath } from "next/cache";
import { logCallSchema, nyLocalToIso } from "@/lib/calls/call-input";
import { agentOfToday, nextInList } from "@/lib/calls/call-queries";
import type { CallOutcome } from "@/lib/calls/types";
import type { FormState } from "@/lib/form-state";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/workspace";
import { t } from "@/messages/pt";

type Input = { leadId: string; agentId: string | null; outcome: CallOutcome; spokeTo: string; notes: string; nextStep: string; nextAt: string | null };

/** Records one call (log_call decides who may and the new status). Returns the next lead of today's list. */
export async function logCallAction(input: Input): Promise<FormState & { next?: string | null }> {
  const parsed = logCallSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: t.calls.errors.invalid };
  const d = parsed.data;
  const nextAt = d.nextAt ? nyLocalToIso(d.nextAt) : null;
  if (d.nextAt && !nextAt) return { status: "error", message: t.calls.errors.badDate, fieldErrors: { nextAt: t.calls.errors.badDate } };
  const user = await getUser();
  const supabase = await createClient();
  if (!user || !supabase) return { status: "error", message: t.calls.errors.failed };
  // The agent comes from the server's own view of today's list, not from the form.
  const agentId = (await agentOfToday(supabase, user.id, d.leadId)) ?? null;
  const { error } = await supabase.rpc("log_call", {
    p_lead: d.leadId,
    p_agent: agentId,
    p_outcome: d.outcome,
    p_spoke_to: d.spokeTo,
    p_notes: d.notes,
    p_next_step: d.nextStep,
    p_next_step_at: nextAt,
  });
  if (error) {
    const msg = error.code === "55000" ? t.calls.errors.noPhone : error.code === "42501" ? t.calls.errors.denied : t.calls.errors.failed;
    return { status: "error", message: msg };
  }
  revalidatePath("/leads/ligar");
  revalidatePath("/leads");
  return { status: "success", next: await nextInList(supabase, user.id, d.leadId) };
}
