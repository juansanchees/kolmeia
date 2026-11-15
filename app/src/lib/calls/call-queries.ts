import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CALL_LOG_COLUMNS, type CallLogRow } from "./types";

const ny = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** The calls of one lead, newest first, at most 50 (RLS decides what the user sees). */
export async function callsOf(db: SupabaseClient, leadId: string): Promise<CallLogRow[]> {
  const { data, error } = await db.from("call_logs").select(CALL_LOG_COLUMNS).eq("lead_id", leadId).order("called_at", { ascending: false }).limit(50);
  if (error) throw new Error(`callsOf: ${error.message}`);
  return (data ?? []) as CallLogRow[];
}

type Item = { lead_id: string; agent_id: string; position: number };

async function todayItems(db: SupabaseClient, userId: string): Promise<Item[]> {
  const { data, error } = await db
    .from("call_list_items")
    .select("lead_id, agent_id, position")
    .eq("caller_id", userId)
    .eq("list_date", ny(new Date()))
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`todayItems: ${error.message}`);
  return (data ?? []) as Item[];
}

/** The agent whose list holds this lead today for this user, or null (a lead opened outside the list). */
export async function agentOfToday(db: SupabaseClient, userId: string, leadId: string): Promise<string | null> {
  return (await todayItems(db, userId)).find((i) => i.lead_id === leadId)?.agent_id ?? null;
}

/** The next lead of today's list after this one that has not been called today, or null at the end. */
export async function nextInList(db: SupabaseClient, userId: string, afterLeadId: string): Promise<string | null> {
  const items = await todayItems(db, userId);
  const at = items.findIndex((i) => i.lead_id === afterLeadId);
  const rest = items.slice(at + 1);
  if (!rest.length) return null;
  const { data, error } = await db
    .from("call_logs")
    .select("lead_id, called_at")
    .in("lead_id", rest.map((i) => i.lead_id))
    .gte("called_at", new Date(Date.now() - 36 * 3_600_000).toISOString())
    .limit(500);
  if (error) throw new Error(`nextInList: ${error.message}`);
  const today = ny(new Date());
  const called = new Set((data ?? []).filter((c) => ny(new Date(c.called_at as string)) === today).map((c) => c.lead_id as string));
  return rest.find((i) => !called.has(i.lead_id))?.lead_id ?? null;
}
