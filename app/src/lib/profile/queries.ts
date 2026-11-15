import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Schedule } from "@/lib/agents/types";
import { baselineReport, type BaselineReport } from "@/lib/leads/baseline";
import type { Dedupable } from "@/lib/research/dedupe";
import type { LearnedProfile } from "./types";

export type ProfileRow = {
  id: string;
  workspace_id: string;
  import_id: string | null;
  agent_id: string | null;
  version: number | null;
  status: "proposed" | "approved" | "rejected" | "superseded";
  profile: LearnedProfile;
  original: LearnedProfile;
  sample_rows: number;
  created_at: string;
  list_name: string;
  row_count: number;
};

const PAGE = 1000;

export async function getProfile(db: SupabaseClient, id: string): Promise<ProfileRow | null> {
  const { data, error } = await db
    .from("learned_profiles")
    .select("id, workspace_id, import_id, agent_id, version, status, profile, original, sample_rows, created_at, lead_imports(list_name, row_count)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getProfile: ${error.message}`);
  if (!data) return null;
  const imp = data.lead_imports as { list_name: string; row_count: number } | { list_name: string; row_count: number }[] | null;
  const i = Array.isArray(imp) ? imp[0] : imp;
  const { lead_imports: _drop, ...rest } = data;
  void _drop;
  return { ...(rest as Omit<ProfileRow, "list_name" | "row_count">), list_name: i?.list_name ?? "", row_count: i?.row_count ?? 0 };
}

/** Non-archived Caçadores of the workspace. */
export async function listHunters(db: SupabaseClient, ws: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await db.from("agents").select("id, name").eq("workspace_id", ws).eq("type", "hunter").is("archived_at", null).order("created_at", { ascending: true });
  if (error) throw new Error(`listHunters: ${error.message}`);
  return (data ?? []) as { id: string; name: string }[];
}

async function allPages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) return out;
  }
}

/** The verified companies of the agent's newest finished run against the training list's new/merged rows. Null: no finished run. */
export async function profileBaseline(db: SupabaseClient, p: ProfileRow, agentId: string): Promise<BaselineReport | null> {
  if (!p.import_id) return null;
  const { data: agent } = await db.from("agents").select("schedule").eq("id", agentId).eq("workspace_id", p.workspace_id).maybeSingle();
  if (!agent) return null;
  const { data: run } = await db
    .from("research_runs")
    .select("id")
    .eq("agent_id", agentId)
    .eq("workspace_id", p.workspace_id)
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return null;
  const [cands, rows] = await Promise.all([
    allPages<{ name: string; website: string | null; phone: string | null }>((a, b) =>
      db.from("research_candidates").select("name, website, phone").eq("run_id", run.id).not("verified_at", "is", null).order("id").range(a, b),
    ),
    allPages<{ data: { name?: string; website?: string; phone?: string } }>((a, b) =>
      db.from("lead_import_rows").select("data").eq("import_id", p.import_id!).in("outcome", ["new", "merged"]).order("row_number").range(a, b),
    ),
  ]);
  const all: Dedupable[] = rows.map((r) => ({ name: r.data.name ?? "", website: r.data.website ?? null, phone: r.data.phone ?? null }));
  return baselineReport({ found: cands, all, hot: [], schedule: agent.schedule as Schedule });
}
