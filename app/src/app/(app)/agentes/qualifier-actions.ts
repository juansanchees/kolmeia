"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/lib/form-state";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

const uuid = z.string().uuid();

// Only these four keys exist; anything else is refused. The database enforces the ranges (guard_qualifier, Q1) and
// the closer's lack of rights (RLS: update is for owner/sdr only), so this is the first of three locks, not the only one.
const patchSchema = z
  .object({
    status: z.enum(["on", "paused"]).optional(),
    daily_cap_usd: z.number().finite().min(0).max(100).optional(),
    lead_cap_usd: z.number().finite().min(0.05).max(5).optional(),
    auto_deep: z.boolean().optional(),
  })
  .strict();

export async function setQualifierAction(patch: { status?: "on" | "paused"; daily_cap_usd?: number; lead_cap_usd?: number; auto_deep?: boolean }): Promise<FormState> {
  const t = await getT();
  const E = t.qualifier.errors;
  const workspace = await requireSender(); // a closer is sent to LEADS before anything is read or written
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return { status: "error", message: E.cap };
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: E.failed };
  const { error } = await supabase.from("qualifiers").update(parsed.data).eq("workspace_id", workspace.id);
  if (error) return { status: "error", message: error.message.startsWith("Q1") ? E.cap : E.failed };
  revalidatePath("/agentes", "layout");
  return { status: "success" };
}

export async function ackLevelNoteAction(leadId: string): Promise<FormState> {
  const t = await getT();
  const E = t.qualifier.errors;
  await requireSender();
  if (!uuid.safeParse(leadId).success) return { status: "error", message: E.failed };
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: E.failed };
  const { error } = await supabase.rpc("ack_level_note", { p_lead: leadId });
  if (error) return { status: "error", message: E.failed };
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads"); // the lead can be open as a modal over the list
  return { status: "success" };
}

/** Owner only (the database enforces it with 42501; the server action reports a fixed code, never the raw error). */
export async function takeOverChargeAction(): Promise<FormState> {
  const t = await getT();
  const E = t.qualifier.errors;
  const workspace = await requireSender();
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: E.failed };
  const { error } = await supabase.rpc("take_over_qualifier_charge", { p_ws: workspace.id });
  if (error) return { status: "error", message: error.code === "42501" ? E.notOwner : E.failed };
  revalidatePath("/agentes", "layout");
  return { status: "success" };
}
