"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseLeadFilters } from "@/lib/leads/view";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, requireSender } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const uuid = z.string().uuid();
type Result = { ok: boolean; message?: string };

/** Saves the current filters under a name (replacing a view of the same name); optionally the one the page opens with. */
export async function saveViewAction(name: string, filters: unknown, makeDefault: boolean): Promise<Result> {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  const supabase = await createClient();
  const n = z.string().trim().min(1).max(60).safeParse(name);
  if (!workspace || !supabase || !n.success) return { ok: false, message: t.leads.views.failed };
  const clean = parseLeadFilters(filters);
  // RLS keeps every statement on the caller's own rows
  if (makeDefault) {
    const { error } = await supabase.from("lead_views").update({ is_default: false }).eq("workspace_id", workspace.id).eq("is_default", true);
    if (error) return { ok: false, message: t.leads.views.failed };
  }
  const { data: found } = await supabase.from("lead_views").select("id").eq("workspace_id", workspace.id).eq("name", n.data).maybeSingle();
  const { error } = found
    ? await supabase.from("lead_views").update({ filters: clean, is_default: makeDefault }).eq("id", found.id as string)
    : await supabase.from("lead_views").insert({ workspace_id: workspace.id, name: n.data, filters: clean, is_default: makeDefault });
  if (error) return { ok: false, message: t.leads.views.failed };
  revalidatePath("/leads");
  return { ok: true, message: t.leads.views.saved };
}

const addSchema = z.object({
  leadIds: z.array(uuid).min(1).max(500),
  target: z.union([z.object({ listId: uuid }), z.object({ name: z.string().trim().min(1).max(120) })]),
});

/** "Adicionar à lista": into an existing list, or a new one (an existing name is reused). Owner/sdr only (RLS too). */
export async function addToListAction(leadIds: string[], target: { listId: string } | { name: string }): Promise<Result> {
  const t = await getT();
  const workspace = await requireSender();
  const p = addSchema.safeParse({ leadIds, target });
  if (!p.success) return { ok: false, message: t.lists.add.none };
  const supabase = await createClient();
  if (!supabase) return { ok: false, message: t.lists.failed };
  let listId: string;
  if ("listId" in p.data.target) listId = p.data.target.listId;
  else {
    const name = p.data.target.name;
    const ins = await supabase.from("lists").insert({ workspace_id: workspace.id, name }).select("id").maybeSingle();
    if (ins.error?.code === "23505") {
      const { data } = await supabase.from("lists").select("id").eq("workspace_id", workspace.id).eq("name", name).maybeSingle();
      if (!data) return { ok: false, message: t.lists.failed };
      listId = data.id as string;
    } else if (ins.error || !ins.data) return { ok: false, message: t.lists.failed };
    else listId = ins.data.id as string;
  }
  const rows = [...new Set(p.data.leadIds)].map((lead_id) => ({ list_id: listId, lead_id, workspace_id: workspace.id }));
  const { error } = await supabase.from("list_leads").upsert(rows, { onConflict: "list_id,lead_id", ignoreDuplicates: true });
  if (error) return { ok: false, message: t.lists.failed };
  revalidatePath("/leads/listas");
  return { ok: true, message: fill(t.lists.add.done, { n: rows.length }) };
}
