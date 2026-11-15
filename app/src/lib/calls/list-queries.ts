import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inChunks, listLeads } from "@/lib/leads/queries";
import type { LeadListItem } from "@/lib/leads/types";
import { CALL_LOG_COLUMNS, type CallListItemRow, type CallLogRow } from "./types";
import { nyDay } from "./ny-day";
import { callAgentMetrics } from "./view";

const ITEM_COLUMNS = "id, workspace_id, agent_id, lead_id, caller_id, list_date, position, manual, created_at";
export type TodayRow = { item: CallListItemRow; lead: LeadListItem; lastCall: CallLogRow | null; calledToday: boolean };

/** Today's rows of call_list_items (RLS decides which: the caller's own, or every row for owner/sdr). */
async function itemsOfToday(db: SupabaseClient, agentId: string | undefined, today: string): Promise<CallListItemRow[]> {
  let q = db.from("call_list_items").select(ITEM_COLUMNS).eq("list_date", today);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data, error } = await q.order("position", { ascending: true }).order("id", { ascending: true }).limit(500);
  if (error) throw new Error(`todayList items: ${error.message}`);
  return (data ?? []) as CallListItemRow[];
}

/** Newest call of each lead, newest first overall. */
async function callsOf(db: SupabaseClient, leadIds: string[]): Promise<CallLogRow[]> {
  const rows = await inChunks<CallLogRow>(
    leadIds,
    (c) => db.from("call_logs").select(CALL_LOG_COLUMNS).in("lead_id", c).order("called_at", { ascending: false }).limit(1000) as never,
    "todayList calls",
  );
  return rows.sort((a, b) => Date.parse(b.called_at) - Date.parse(a.called_at));
}

export async function todayList(db: SupabaseClient, opts: { agentId?: string } = {}, now: Date = new Date()): Promise<TodayRow[]> {
  const today = nyDay(now);
  const items = await itemsOfToday(db, opts.agentId, today);
  if (items.length === 0) return [];
  const ids = [...new Set(items.map((i) => i.lead_id))];
  const [leads, calls] = await Promise.all([listLeads(db, items[0].workspace_id, { ids }), callsOf(db, ids)]);
  const leadBy = new Map(leads.map((l) => [l.lead.id, l]));
  const lastBy = new Map<string, CallLogRow>();
  for (const c of calls) if (!lastBy.has(c.lead_id)) lastBy.set(c.lead_id, c);
  const out: TodayRow[] = [];
  for (const item of items) {
    const lead = leadBy.get(item.lead_id);
    if (!lead) continue; // not visible any more (RLS) or gone
    const lastCall = lastBy.get(item.lead_id) ?? null;
    out.push({ item, lead, lastCall, calledToday: lastCall !== null && nyDay(new Date(lastCall.called_at)) === today });
  }
  return out;
}

/** Numbers of one agent's list today (spec §6.6): in the list, called, answered, meeting booked. */
export async function agentCallStats(db: SupabaseClient, agentId: string, now: Date = new Date()) {
  const today = nyDay(now);
  const items = await itemsOfToday(db, agentId, today);
  if (items.length === 0) return callAgentMetrics([], []);
  const calls = (await callsOf(db, [...new Set(items.map((i) => i.lead_id))])).filter((c) => nyDay(new Date(c.called_at)) === today);
  return callAgentMetrics(items, calls);
}

/** Size of today's list per call agent (RLS decides which rows are visible). */
export async function listSizesToday(db: SupabaseClient, now: Date = new Date()): Promise<Record<string, number>> {
  const { data } = await db.from("call_list_items").select("agent_id").eq("list_date", nyDay(now)).limit(5000);
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as { agent_id: string }[]) out[r.agent_id] = (out[r.agent_id] ?? 0) + 1;
  return out;
}
