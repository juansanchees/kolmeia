"use server";

import { revalidatePath } from "next/cache";
import { homeRuleSchema } from "@/lib/home/rule";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { t } from "@/messages/pt";

/** Saves the signed-in user's own "Ligar primeiro" rule. The rule is validated here (it comes from the browser); user_id is the column default (auth.uid()), so the row is always their own (RLS). */
export async function saveHomeRuleAction(rule: unknown): Promise<{ ok: boolean; message?: string }> {
  const parsed = homeRuleSchema.safeParse(rule);
  const [workspace, supabase] = [await getCurrentWorkspace(), await createClient()];
  if (!parsed.success || !workspace || !supabase) return { ok: false, message: t.home.editor.failed };
  const { error } = await supabase
    .from("home_rules")
    .upsert({ workspace_id: workspace.id, rule: parsed.data, updated_at: new Date().toISOString() }, { onConflict: "workspace_id,user_id" });
  if (error) return { ok: false, message: t.home.editor.failed };
  revalidatePath("/inicio");
  return { ok: true };
}
