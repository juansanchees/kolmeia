"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

const input = z.object({ campaignId: z.string().uuid(), leadIds: z.array(z.string().uuid()).min(1).max(500) });

/** Puts leads on a campaign's list (C3/C2 rules live in SQL). Owner/sdr only. It never sends anything. */
export async function addLeadsToCampaignAction(
  campaignId: string,
  leadIds: string[],
): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; error: string }> {
  const t = await getT();
  const C = t.leads.campaign;
  await requireSender();
  const parsed = input.safeParse({ campaignId, leadIds });
  if (!parsed.success) return { ok: false, error: C.badInput };
  const supabase = await createClient();
  if (!supabase) return { ok: false, error: C.failed };
  const { data, error } = await supabase.rpc("add_leads_to_campaign", { p_campaign: parsed.data.campaignId, p_leads: parsed.data.leadIds });
  if (error) return { ok: false, error: error.code === "55000" ? C.archived : error.code === "42501" ? C.notAllowed : error.code === "22023" ? C.badInput : C.failed };
  revalidatePath("/leads", "layout");
  revalidatePath("/campanhas", "layout");
  revalidatePath("/inicio");
  return { ok: true, counts: (data ?? {}) as Record<string, number> };
}
