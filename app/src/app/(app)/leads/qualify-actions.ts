"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { reserveFor } from "@/lib/ai/gateway";
import { lightDef } from "@/lib/ai/qualify-tasks";
import { reserveUsdFor } from "@/lib/ai/tasks";
import { estimateQualifyUsd } from "@/lib/qualifier/estimate";
import { PLACES_CALL_USD } from "@/lib/qualifier/places";
import { hasPlaces } from "@/lib/qualifier/places-config";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const E = t.qualifier.errors;
const MAX = 500;
const ids = z.array(z.string().uuid()).max(MAX);

type Estimate = { ok: true; count: number; usd: number; leftTodayUsd: number } | { ok: false; error: string };

/** What qualifying these leads on request would cost at most, and what the Qualificador has left today. */
export async function estimateQualifyAction(leadIds: string[]): Promise<Estimate> {
  const workspace = await requireSender();
  const parsed = ids.safeParse(leadIds);
  if (!parsed.success) return { ok: false, error: E.failed };
  const supabase = await createClient();
  if (!supabase) return { ok: false, error: E.failed };
  const [queue, status] = await Promise.all([
    parsed.data.length
      ? supabase.from("qualifier_queue").select("lead_id, spent_usd, done_reason").eq("workspace_id", workspace.id).in("lead_id", parsed.data)
      : Promise.resolve({ data: [], error: null }),
    supabase.rpc("qualifier_status", { p_ws: workspace.id }),
  ]);
  if (queue.error || status.error || !status.data) return { ok: false, error: E.failed };
  const st = status.data as { daily_cap_usd: number; lead_cap_usd: number; spent_today: number };
  const { data: lv } = parsed.data.length ? await supabase.from("leads").select("id, level").eq("workspace_id", workspace.id).in("id", parsed.data) : { data: [] };
  const level = new Map((lv ?? []).map((l) => [l.id as string, Number(l.level)]));
  const rows = (queue.data ?? []).map((q) => ({ level: level.get(q.lead_id as string) ?? 0, spentUsd: Number(q.spent_usd), doneReason: (q.done_reason as string | null) ?? null }));
  const usd = estimateQualifyUsd(rows, {
    leadCapUsd: Number(st.lead_cap_usd),
    placesUsd: hasPlaces() ? PLACES_CALL_USD : null,
    lightUsd: reserveFor(lightDef),
    deepUsd: reserveUsdFor("verify", "careful"),
  });
  const leftTodayUsd = Math.max(0, Math.round((Number(st.daily_cap_usd) - Number(st.spent_today)) * 100) / 100);
  return { ok: true, count: rows.length, usd, leftTodayUsd };
}

/** Puts the leads at the front of the Qualificador's queue with the strong AI step on (request_qualification, 0014). */
export async function requestQualifyAction(leadIds: string[]): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const workspace = await requireSender();
  const parsed = ids.safeParse(leadIds);
  if (!parsed.success || parsed.data.length === 0) return { ok: false, error: E.failed };
  const supabase = await createClient();
  if (!supabase) return { ok: false, error: E.failed };
  const { data, error } = await supabase.rpc("request_qualification", { p_ws: workspace.id, p_leads: parsed.data });
  if (error) return { ok: false, error: E.failed };
  revalidatePath("/leads");
  revalidatePath("/agentes", "layout");
  return { ok: true, count: typeof data === "number" ? data : 0 };
}
