import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inChunks, inLeadChunks, LEADS_MAX } from "@/lib/leads/queries";
import { displayOf } from "@/lib/leads/view";
import type { LeadFieldRow } from "@/lib/leads/types";
import type { CandidateRow } from "@/lib/research/rows";
import type { TaskRow } from "./view";

/** Open tasks the user can see (RLS: senders all, the closer those of her leads), soonest first. */
export async function openTasks(db: SupabaseClient, workspaceId: string): Promise<TaskRow[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, lead_id, kind, title, due_at, done_at, assignee_id")
    .eq("workspace_id", workspaceId)
    .is("done_at", null)
    .order("due_at")
    .order("id")
    .limit(1000);
  if (error) throw new Error(`openTasks: ${error.message}`);
  return (data ?? []) as TaskRow[];
}

/** Every task (open or done) due in [from, to), for the Agenda; RLS decides what the user sees. */
export async function tasksBetween(db: SupabaseClient, workspaceId: string, from: string, to: string): Promise<TaskRow[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, lead_id, kind, title, due_at, done_at, assignee_id")
    .eq("workspace_id", workspaceId)
    .gte("due_at", from)
    .lt("due_at", to)
    .order("due_at")
    .order("id")
    .limit(2000);
  if (error) throw new Error(`tasksBetween: ${error.message}`);
  return (data ?? []) as TaskRow[];
}

/** A lead as the Agenda needs it: its shown name and city, who it is assigned to, and whether it is still open. */
export type LeadOptionRow = { id: string; name: string; city: string | null; owner: string | null; open: boolean };

const CLOSED = new Set(["won", "lost", "discarded"]);

/**
 * Names (and city, owner) of the leads the user sees, without the full leads read: the name is the best candidate's,
 * else the oldest name field (the same rule as the list's displayOf). A lead whose best candidate is not visible is left
 * out, like the list does.
 */
export async function leadOptionsOf(db: SupabaseClient, workspaceId: string): Promise<LeadOptionRow[]> {
  const leads: { id: string; owner_id: string | null; status: string; best_candidate_id: string | null }[] = [];
  for (let from = 0; from < LEADS_MAX; from += 1000) {
    const { data, error } = await db.from("leads").select("id, owner_id, status, best_candidate_id").eq("workspace_id", workspaceId).order("id").range(from, from + 999);
    if (error) throw new Error(`leadOptionsOf: ${error.message}`);
    leads.push(...((data ?? []) as typeof leads));
    if ((data ?? []).length < 1000) break;
  }
  const bestIds = leads.map((l) => l.best_candidate_id).filter((x): x is string => Boolean(x));
  const bare = leads.filter((l) => !l.best_candidate_id).map((l) => l.id);
  const [cands, fields] = await Promise.all([
    inChunks<{ id: string; name: string | null; city: string | null }>(bestIds, (c) => db.from("research_candidates").select("id, name, city").in("id", c) as never, "leadOptionsOf candidates"),
    inLeadChunks<LeadFieldRow>(bare, (c) => db.from("lead_fields").select("id, lead_id, field, value, source, source_ref, status, excerpt, seen_at").in("lead_id", c).in("field", ["name", "city"]) as never, "leadOptionsOf fields"),
  ]);
  const cand = new Map(cands.map((c) => [c.id, c]));
  const fieldsBy = new Map<string, LeadFieldRow[]>();
  for (const f of fields) fieldsBy.set(f.lead_id, [...(fieldsBy.get(f.lead_id) ?? []), f]);
  const out: LeadOptionRow[] = [];
  for (const l of leads) {
    const best = l.best_candidate_id ? cand.get(l.best_candidate_id) : null;
    if (l.best_candidate_id && !best) continue;
    const d = displayOf((best ?? null) as CandidateRow | null, best ? [] : (fieldsBy.get(l.id) ?? []));
    out.push({ id: l.id, name: d.name, city: d.city?.trim() || null, owner: l.owner_id, open: !CLOSED.has(l.status) });
  }
  return out;
}
