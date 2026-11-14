import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inChunks } from "@/lib/leads/queries";
import { periodStart, type SourceRun, type SpendCall, type SpendPeriod } from "./view";

const PAGE = 1000;
export const SPEND_MAX = 20_000;
const COLUMNS = "id, run_id, lead_id, task, model, input_tokens, output_tokens, web_searches, web_fetches, cost_usd, reserve_usd, status, created_at";

const num = (v: unknown) => Number(v ?? 0);

/** The ledger rows of a period (RLS: owner/sdr only), plus the names Gastos needs. Never more than SPEND_MAX rows. */
export async function loadSpend(
  db: SupabaseClient,
  ws: string,
  p: SpendPeriod,
  now: Date = new Date(),
): Promise<{ calls: SpendCall[]; runAgent: Map<string, string | null>; leads: Map<string, string>; truncated: boolean }> {
  const since = periodStart(p, now).toISOString();
  const calls: SpendCall[] = [];
  let truncated = false;
  for (let from = 0; from < SPEND_MAX; from += PAGE) {
    const { data, error } = await db
      .from("ai_calls")
      .select(COLUMNS)
      .eq("workspace_id", ws)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loadSpend: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      calls.push({
        id: r.id as string,
        run_id: (r.run_id as string | null) ?? null,
        lead_id: (r.lead_id as string | null) ?? null,
        task: r.task as string,
        model: r.model as string,
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        web_searches: num(r.web_searches),
        web_fetches: num(r.web_fetches),
        cost_usd: num(r.cost_usd),
        reserve_usd: num(r.reserve_usd),
        status: r.status as string,
        created_at: r.created_at as string,
      });
    }
    if (rows.length < PAGE) break;
    if (from + PAGE >= SPEND_MAX) truncated = true;
  }

  const runIds = [...new Set(calls.map((c) => c.run_id).filter((x): x is string => Boolean(x)))];
  const runs = await inChunks<{ id: string; agent_id: string | null }>(runIds, (c) => db.from("research_runs").select("id, agent_id").in("id", c), "spend runs");
  const agentIds = [...new Set(runs.map((r) => r.agent_id).filter((x): x is string => Boolean(x)))];
  const agents = await inChunks<{ id: string; name: string }>(agentIds, (c) => db.from("agents").select("id, name").in("id", c), "spend agents");
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const runAgent = new Map<string, string | null>(runs.map((r) => [r.id, r.agent_id ? (agentName.get(r.agent_id) ?? null) : null]));

  const leadIds = [...new Set(calls.map((c) => c.lead_id).filter((x): x is string => Boolean(x)))];
  const fields = await inChunks<{ lead_id: string; value: string; status: string }>(
    leadIds,
    (c) => db.from("lead_fields").select("lead_id, value, status").eq("field", "name").neq("status", "refuted").in("lead_id", c).limit(1000),
    "spend leads",
  );
  const leads = new Map<string, string>();
  for (const f of fields) if (!leads.has(f.lead_id) || f.status === "confirmed") leads.set(f.lead_id, f.value);
  return { calls, runAgent, leads, truncated };
}

/** Every row of a query, a PostgREST page (1000) at a time and never more than SPEND_MAX; `page` must order by a stable key. */
async function allRows<T>(label: string, page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < SPEND_MAX; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** F3d's paid sources in the period (source_runs; RLS: owner/sdr only). */
export async function loadSourceRuns(db: SupabaseClient, ws: string, p: SpendPeriod, now: Date = new Date()): Promise<SourceRun[]> {
  const since = periodStart(p, now).toISOString();
  const rows = await allRows<Record<string, unknown>>("loadSourceRuns", (from, to) =>
    db.from("source_runs").select("id, provider, kind, status, cost_usd, reserve_usd").eq("workspace_id", ws).gte("created_at", since).order("id", { ascending: true }).range(from, to),
  );
  return rows.map((r) => ({
    provider: r.provider as string,
    kind: r.kind as string,
    status: r.status as string,
    cost_usd: r.cost_usd === null || r.cost_usd === undefined ? null : num(r.cost_usd),
    reserve_usd: num(r.reserve_usd),
  }));
}

/** The workspace's UTC-day AI spend (pending at its reserve) and its cap, for the second header line. */
export async function loadWorkspaceToday(db: SupabaseClient, ws: string, now: Date = new Date()): Promise<{ spent: number; cap: number }> {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const [rows, settings] = await Promise.all([
    allRows<Record<string, unknown>>("loadWorkspaceToday", (from, to) =>
      db.from("ai_calls").select("id, status, cost_usd, reserve_usd").eq("workspace_id", ws).gte("created_at", utc).order("id", { ascending: true }).range(from, to),
    ),
    db.from("workspace_settings").select("ai_daily_cap_usd").eq("workspace_id", ws).maybeSingle(),
  ]);
  const spent = rows.reduce((s, r) => s + (r.status === "pending" ? Math.max(num(r.reserve_usd), num(r.cost_usd)) : num(r.cost_usd)), 0);
  return { spent, cap: settings.data ? num(settings.data.ai_daily_cap_usd) : 10 };
}
