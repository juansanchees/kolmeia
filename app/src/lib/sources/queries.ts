import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunView } from "@/components/sources/RunHistory";
import type { AgentSourcesView } from "@/components/sources/AgentSources";

// Reads as the user (RLS: only owner and sdr see runs and agent settings). Keys are never selected: only the last 4.

export type ConnectedSources = { maps: boolean; apollo: boolean; today: { apify: { spent: number | null; cap: number | null }; apollo: { calls: number | null; cap: number | null } } };
type ConnRow = { provider: string; daily_cap_usd: number | null; daily_calls: number | null; spent_today_usd: number | null; calls_today: number | null };
const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** Which sources this workspace connected (and today's use). Any error reads as "nothing connected": the buttons stay hidden. */
export async function connectedSources(db: SupabaseClient, ws: string): Promise<ConnectedSources> {
  const none: ConnectedSources = { maps: false, apollo: false, today: { apify: { spent: null, cap: null }, apollo: { calls: null, cap: null } } };
  const { data, error } = await db.rpc("list_source_connections", { p_ws: ws });
  if (error || !Array.isArray(data)) return none;
  const rows = data as ConnRow[];
  const apify = rows.find((r) => r.provider === "apify");
  const apollo = rows.find((r) => r.provider === "apollo");
  return {
    maps: !!apify,
    apollo: !!apollo,
    today: { apify: { spent: num(apify?.spent_today_usd), cap: num(apify?.daily_cap_usd) }, apollo: { calls: num(apollo?.calls_today), cap: num(apollo?.daily_calls) } },
  };
}

const RUN_COLS = "id, kind, query, status, error, found, dropped, cost_usd, reserve_usd, import_id, created_at";

/** The workspace's last 50 searches, newest first. Contact runs (the Qualificador's P2b) are not searches: they show in Gastos. */
export async function listRuns(db: SupabaseClient, ws: string): Promise<RunView[]> {
  const { data, error } = await db.from("source_runs").select(RUN_COLS).eq("workspace_id", ws).in("kind", ["maps", "apollo"]).order("created_at", { ascending: false }).limit(50);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    kind: r.kind as RunView["kind"],
    query: (r.query ?? {}) as Record<string, unknown>,
    status: String(r.status),
    error: (r.error as string | null) ?? null,
    found: num(r.found),
    dropped: num(r.dropped),
    cost_usd: num(r.cost_usd),
    reserve_usd: num(r.reserve_usd) ?? 0,
    import_id: (r.import_id as string | null) ?? null,
    created_at: String(r.created_at),
  }));
}

export async function agentSourceSettings(db: SupabaseClient, agentId: string): Promise<AgentSourcesView | null> {
  const { data } = await db
    .from("agent_source_settings")
    .select("maps_on, maps_terms, maps_location, maps_max, apollo_on, apollo_locations, apollo_naics, apollo_pages")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!data) return null;
  const d = data as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    maps_on: d.maps_on === true,
    maps_terms: arr(d.maps_terms),
    maps_location: typeof d.maps_location === "string" ? d.maps_location : "",
    maps_max: num(d.maps_max) ?? 50,
    apollo_on: d.apollo_on === true,
    apollo_locations: arr(d.apollo_locations),
    apollo_naics: arr(d.apollo_naics),
    apollo_pages: num(d.apollo_pages) ?? 1,
  };
}
