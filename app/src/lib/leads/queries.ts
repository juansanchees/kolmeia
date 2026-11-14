import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CANDIDATE_COLUMNS, normalizeCandidate, type CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import { LEAD_COLUMNS, type LeadDetail, type LeadListItem, type LeadRow } from "./types";

/**
 * Ids per `.in()` request. Two limits at once: the URL stays small (100 UUIDs is ~3.8 KB, 500 would be ~19 KB, over
 * common 8-16 KB limits), and PostgREST returns at most 1000 rows per response, silently truncating the rest. A
 * candidate has at most 8 checks, so 100 ids give at most 800 check rows per request. Keep ID_CHUNK * 8 <= 1000.
 */
export const ID_CHUNK = 100;

/** Runs `run` for each chunk of ids in parallel and concatenates the rows; throws on the first error. */
export async function inChunks<T>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
  const results = await Promise.all(chunks.map((c) => run(c)));
  const out: T[] = [];
  for (const r of results) {
    if (r.error) throw new Error(`${label}: ${r.error.message}`);
    out.push(...(r.data ?? []));
  }
  return out;
}

const CHECK_SELECT = "id, candidate_id, kind, pass, result, summary, research_evidence(url, title, excerpt, seen_at)";

type RawCheck = Record<string, unknown> & { research_evidence: CheckWithEvidence["evidence"] | null };

function toChecks(rows: unknown[] | null): CheckWithEvidence[] {
  return (rows ?? []).map((r) => {
    const { research_evidence, ...rest } = r as RawCheck;
    return { ...(rest as unknown as Omit<CheckWithEvidence, "evidence">), evidence: research_evidence ?? [] };
  });
}

/** Leads of a workspace with their best candidate. Runs as the user, so RLS decides what the closer sees. */
export async function listLeads(db: SupabaseClient, workspaceId: string): Promise<LeadListItem[]> {
  const { data: leadRows, error } = await db
    .from("leads")
    .select(LEAD_COLUMNS)
    .eq("workspace_id", workspaceId)
    .not("best_candidate_id", "is", null)
    .order("last_seen_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`listLeads: ${error.message}`);
  const leads = (leadRows ?? []) as LeadRow[];
  if (leads.length === 0) return [];

  const bestIds = leads.map((l) => l.best_candidate_id as string);
  const agentIds = [...new Set(leads.map((l) => l.origin_agent_id).filter((x): x is string => Boolean(x)))];

  const [candRows, agentRows, checkRows] = await Promise.all([
    inChunks<Record<string, unknown>>(bestIds, (c) => db.from("research_candidates").select(CANDIDATE_COLUMNS).in("id", c) as never, "listLeads candidates"),
    inChunks<Record<string, unknown>>(agentIds, (c) => db.from("agents").select("id, name").in("id", c) as never, "listLeads agents"),
    inChunks<unknown>(bestIds, (c) => db.from("research_checks").select(CHECK_SELECT).in("candidate_id", c) as never, "listLeads checks"),
  ]);

  const candById = new Map(candRows.map((r) => [r.id as string, normalizeCandidate(r)]));
  const agentName = new Map(agentRows.map((a) => [a.id as string, a.name as string]));
  const proofBy = new Map<string, number>();
  for (const c of toChecks(checkRows)) {
    if (c.result === "ok" && c.evidence.length > 0) proofBy.set(c.candidate_id, (proofBy.get(c.candidate_id) ?? 0) + 1);
  }

  const items: LeadListItem[] = [];
  for (const lead of leads) {
    const best = candById.get(lead.best_candidate_id as string);
    if (!best) continue; // not visible (or gone): skip rather than crash
    items.push({
      lead,
      best,
      agentName: lead.origin_agent_id ? (agentName.get(lead.origin_agent_id) ?? null) : null,
      proofOk: proofBy.get(best.id) ?? 0,
    });
  }
  return items;
}

/** One lead with every candidate that joined it (newest first, with the run they came from) and their proof. */
export async function getLead(db: SupabaseClient, id: string): Promise<LeadDetail | null> {
  const { data: leadRow, error } = await db.from("leads").select(LEAD_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`getLead: ${error.message}`);
  if (!leadRow) return null;
  const lead = leadRow as LeadRow;

  const { data: candRows, error: cErr } = await db
    .from("research_candidates")
    .select(`${CANDIDATE_COLUMNS}, research_runs(title, created_at)`)
    .eq("lead_id", id)
    .order("verified_at", { ascending: false, nullsFirst: false });
  if (cErr) throw new Error(`getLead candidates: ${cErr.message}`);

  const candidates: LeadDetail["candidates"] = (candRows ?? []).map((r) => {
    const { research_runs, ...rest } = r as unknown as Record<string, unknown> & { research_runs: { title: string; created_at: string } | { title: string; created_at: string }[] | null };
    const run = Array.isArray(research_runs) ? research_runs[0] : research_runs;
    return { ...(normalizeCandidate(rest) as CandidateRow), run_title: run?.title ?? "", run_created_at: run?.created_at ?? "" };
  });

  let agentName: string | null = null;
  if (lead.origin_agent_id) {
    const { data } = await db.from("agents").select("name").eq("id", lead.origin_agent_id).maybeSingle();
    agentName = (data as { name: string } | null)?.name ?? null;
  }

  const checks = toChecks(
    await inChunks<unknown>(
      candidates.map((c) => c.id),
      (c) => db.from("research_checks").select(CHECK_SELECT).in("candidate_id", c).order("created_at", { ascending: true }) as never,
      "getLead checks",
    ),
  );
  return { lead, agentName, candidates, checks };
}
