import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listLeads } from "@/lib/leads/queries";
import { townOf } from "./region";
import { COVERAGE_DAYS, type CoverageSearch } from "./view";

/**
 * Bounds, so a big workspace never loads unbounded rows: the newest 500 runs, 100 imports and 500 marks; city values
 * are read only from the 25 newest imports that are still inside the coverage window (an older import marks nothing),
 * 5,000 rows each (K-6 cap), fetching just the city column. Lead towns come from listLeads (up to 5,000 leads).
 */
export const RUNS_MAX = 500;
export const IMPORTS_MAX = 100;
export const IMPORT_SCAN_MAX = 25;
export const MARKS_MAX = 500;
const PAGE = 1000;
const IMPORT_ROWS_MAX = 5000;
const DAY_MS = 86_400_000;

export type CoverageMark = { id: string; town: string; searched_at: string; note: string };
export type CoverageData = { searches: CoverageSearch[]; leadTowns: Map<string, number>; marks: CoverageMark[] };

async function importTowns(db: SupabaseClient, importId: string): Promise<string[]> {
  const towns = new Set<string>();
  for (let from = 0; from < IMPORT_ROWS_MAX; from += PAGE) {
    const { data, error } = await db
      .from("lead_import_rows")
      .select("city:data->>city")
      .eq("import_id", importId)
      .in("outcome", ["new", "merged"])
      .order("row_number")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`loadCoverage import rows: ${error.message}`);
    for (const r of (data ?? []) as unknown as { city: string | null }[]) {
      const town = townOf(r.city);
      if (town) towns.add(town);
    }
    if ((data ?? []).length < PAGE) break;
  }
  return [...towns];
}

export async function loadCoverage(db: SupabaseClient, ws: string, now: Date = new Date()): Promise<CoverageData> {
  const [runsRes, importsRes, marksRes, leads] = await Promise.all([
    db
      .from("research_runs")
      .select("id, title, region_text, started_at, progress, agent_id")
      .eq("workspace_id", ws)
      .not("started_at", "is", null)
      .is("setup_agent_id", null)
      .not("status", "in", "(failed,cancelled)")
      .order("started_at", { ascending: false })
      .limit(RUNS_MAX),
    db
      .from("lead_imports")
      .select("id, list_name, created_at, row_count, new_count, status")
      .eq("workspace_id", ws)
      .in("status", ["done", "importing"])
      .order("created_at", { ascending: false })
      .limit(IMPORTS_MAX),
    db.from("coverage_marks").select("id, town, searched_at, note").eq("workspace_id", ws).order("searched_at", { ascending: false }).limit(MARKS_MAX),
    listLeads(db, ws),
  ]);
  for (const r of [runsRes, importsRes, marksRes]) if (r.error) throw new Error(`loadCoverage: ${r.error.message}`);

  const runs = (runsRes.data ?? []) as { id: string; title: string; region_text: string; started_at: string; progress: { counts?: { verified?: number } } | null; agent_id: string | null }[];
  const agentIds = [...new Set(runs.map((r) => r.agent_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  for (let i = 0; i < agentIds.length; i += 100) {
    const { data, error } = await db.from("agents").select("id, name").in("id", agentIds.slice(i, i + 100));
    if (error) throw new Error(`loadCoverage agents: ${error.message}`);
    for (const a of data ?? []) names.set(a.id as string, a.name as string);
  }

  const searches: CoverageSearch[] = runs.map((r) => ({
    kind: r.agent_id ? "hunter" : "research",
    label: (r.agent_id && names.get(r.agent_id)) || r.title,
    regionText: r.region_text || null,
    towns: null,
    at: r.started_at,
    newCount: typeof r.progress?.counts?.verified === "number" ? r.progress.counts.verified : null,
    rows: null,
  }));

  const imports = (importsRes.data ?? []) as { id: string; list_name: string; created_at: string; row_count: number; new_count: number }[];
  const cutoff = now.getTime() - COVERAGE_DAYS * DAY_MS;
  const scan = new Set(imports.filter((i) => Date.parse(i.created_at) >= cutoff).slice(0, IMPORT_SCAN_MAX).map((i) => i.id));
  const townsBy = new Map<string, string[]>();
  await Promise.all([...scan].map(async (id) => townsBy.set(id, await importTowns(db, id))));
  for (const i of imports) {
    searches.push({ kind: "import", label: i.list_name, regionText: null, towns: townsBy.get(i.id) ?? [], at: i.created_at, newCount: i.new_count, rows: i.row_count });
  }

  const marks = (marksRes.data ?? []) as CoverageMark[];
  for (const m of marks) searches.push({ kind: "manual", label: m.note || m.town, regionText: null, towns: [m.town], at: m.searched_at, newCount: null, rows: null });

  const leadTowns = new Map<string, number>();
  for (const l of leads) {
    const town = townOf(l.display.city);
    if (town) leadTowns.set(town, (leadTowns.get(town) ?? 0) + 1);
  }
  return { searches, leadTowns, marks };
}
