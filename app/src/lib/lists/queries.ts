import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LEADS_MAX, listLeads } from "@/lib/leads/queries";
import { leadsCsv } from "@/lib/leads/view";

// Named lists of leads (migration 0027). Owner/sdr only: RLS gives the closer no list rows at all.

export type ListStat = { id: string; name: string; created_at: string; leads: number; contacted: number; with_phone: number };

export async function listStats(db: SupabaseClient, workspaceId: string): Promise<ListStat[]> {
  const { data, error } = await db.rpc("list_stats", { p_ws: workspaceId });
  if (error) throw new Error(`listStats: ${error.message}`);
  return (data ?? []) as ListStat[];
}

/** Lead ids of a list (PostgREST pages of 1000, up to LEADS_MAX). */
export async function listLeadIds(db: SupabaseClient, listId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; from < LEADS_MAX; from += 1000) {
    const { data, error } = await db.from("list_leads").select("lead_id").eq("list_id", listId).order("lead_id").range(from, from + 999);
    if (error) throw new Error(`listLeadIds: ${error.message}`);
    ids.push(...(data ?? []).map((r) => r.lead_id as string));
    if ((data ?? []).length < 1000) break;
  }
  return ids;
}

/** The list's CSV, built from the leads the user can see (same columns and formula escaping as the LEADS CSV); null when the list is not visible. */
export async function listCsv(db: SupabaseClient, workspaceId: string, listId: string): Promise<{ name: string; csv: string } | null> {
  const { data, error } = await db.from("lists").select("name").eq("id", listId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error(`listCsv: ${error.message}`);
  if (!data) return null;
  const ids = await listLeadIds(db, listId);
  const items = ids.length > 0 ? await listLeads(db, workspaceId, { ids }) : [];
  return { name: data.name as string, csv: leadsCsv(items) };
}

/** Id and name of every list of the workspace, by name. */
export async function listNames(db: SupabaseClient, workspaceId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await db.from("lists").select("id, name").eq("workspace_id", workspaceId).order("name").limit(500);
  if (error) throw new Error(`listNames: ${error.message}`);
  return (data ?? []) as { id: string; name: string }[];
}
