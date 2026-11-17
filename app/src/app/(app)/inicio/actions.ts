"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addDays } from "@/lib/agenda/view";
import { nyDay } from "@/lib/calls/ny-day";
import { ITEM_KEY, planSchema } from "@/lib/home/plan";
import { DEFAULT_HOME_RULE, homeRuleSchema } from "@/lib/home/rule";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

type Result = { ok: boolean; message?: string };

/**
 * Saves the signed-in user's own day plan and, when given, the "Ligar agora" rule (both come from the browser, so both
 * are validated here). Without a rule only the plan column changes, so a stored rule is never replaced by the default;
 * a first save (no row yet) starts with the default rule. user_id is the column default (auth.uid()): always their own row (RLS).
 */
export async function saveDayPlanAction(input: { plan: unknown; rule?: unknown }): Promise<Result> {
  const t = await getT();
  const plan = planSchema.safeParse(input?.plan);
  const rule = input?.rule === undefined ? null : homeRuleSchema.safeParse(input.rule);
  const [workspace, supabase, user] = [await getCurrentWorkspace(), await createClient(), await getUser()];
  if (!plan.success || (rule && !rule.success) || !workspace || !supabase || !user) return { ok: false, message: t.home.config.failed };
  const at = new Date().toISOString();
  if (rule?.data) {
    const { error } = await supabase
      .from("home_rules")
      .upsert({ workspace_id: workspace.id, rule: rule.data, plan: plan.data, updated_at: at }, { onConflict: "workspace_id,user_id" });
    if (error) return { ok: false, message: t.home.config.failed };
  } else {
    const { data, error } = await supabase.from("home_rules").update({ plan: plan.data, updated_at: at }).eq("workspace_id", workspace.id).eq("user_id", user.id).select("user_id");
    if (error) return { ok: false, message: t.home.config.failed };
    if (!data?.length) {
      const ins = await supabase.from("home_rules").insert({ workspace_id: workspace.id, rule: DEFAULT_HOME_RULE, plan: plan.data, updated_at: at });
      if (ins.error) return { ok: false, message: t.home.config.failed };
    }
  }
  revalidatePath("/inicio");
  return { ok: true };
}

/**
 * Ticks (on) or unticks an item of today's plan (New York day, the server's clock). Own rows only (RLS). The screen
 * already shows the tick, so nothing is re-rendered; ticks older than 30 days are dropped on the way.
 */
export async function markItemAction(key: string, on: boolean): Promise<Result> {
  const t = await getT();
  const p = z.object({ key: z.string().regex(ITEM_KEY), on: z.boolean() }).safeParse({ key, on });
  const [workspace, supabase, user] = [await getCurrentWorkspace(), await createClient(), await getUser()];
  if (!p.success || !workspace || !supabase || !user) return { ok: false, message: t.home.plan.failed };
  const day = nyDay(new Date());
  const { error } = p.data.on
    ? await supabase.from("day_plan_marks").upsert({ workspace_id: workspace.id, day, item_key: p.data.key }, { onConflict: "workspace_id,user_id,day,item_key", ignoreDuplicates: true })
    : await supabase.from("day_plan_marks").delete().eq("workspace_id", workspace.id).eq("user_id", user.id).eq("day", day).eq("item_key", p.data.key);
  if (error) return { ok: false, message: t.home.plan.failed };
  await supabase.from("day_plan_marks").delete().eq("workspace_id", workspace.id).eq("user_id", user.id).lt("day", addDays(day, -30));
  return { ok: true };
}
