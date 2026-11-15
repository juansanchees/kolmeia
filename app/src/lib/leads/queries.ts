import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CANDIDATE_COLUMNS, normalizeCandidate, type CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import { displayOf } from "./view";
import { LEAD_COLUMNS, LEAD_FIELD_COLUMNS, type LeadDetail, type LeadFieldRow, type LeadListItem, type LeadRow } from "./types";

/**
 * Ids per `.in()` request. Two limits at once: the URL stays small (100 UUIDs is ~3.8 KB, 500 would be ~19 KB, over
 * common 8-16 KB limits), and PostgREST returns at most 1000 rows per response, silently truncating the rest. A
 * candidate has at most 8 checks, so 100 ids give at most 800 check rows per request. Keep ID_CHUNK * 8 <= 1000.
 */
export const ID_CHUNK = 100;

/** The `as never` casts below exist because the Supabase builder is a PromiseLike with its own generics; inChunks only needs { data, error }. */
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

const DISPLAY_FIELDS = ["name", "website", "phone", "email", "city"];

const CHECK_SELECT = "id, candidate_id, kind, pass, result, summary, created_at, research_evidence(url, title, excerpt, seen_at)";

type RawCheck = Record<string, unknown> & { research_evidence: CheckWithEvidence["evidence"] | null };

function toChecks(rows: unknown[] | null): CheckWithEvidence[] {
  return (rows ?? []).map((r) => {
    const { research_evidence, ...rest } = r as RawCheck;
    return { ...(rest as unknown as Omit<CheckWithEvidence, "evidence">), evidence: research_evidence ?? [] };
  });
}

/** Leads read per list (K-6: an import holds at most 5,000 rows) and rows per PostgREST page (its cap is 1000). */
export const LEADS_MAX = 5000;
const PAGE = 1000;
/**
 * Leads per `.in("lead_id")` request for their fields: the URL stays small and, at the 14 field kinds an import can
 * write (up to ~20 values per lead in practice), 50 leads stay well under the 1000-row response cap.
 */
export const FIELD_CHUNK = 50;

/** PostgREST answers at most this many rows per request, silently dropping the rest. */
const RESPONSE_CAP = 1000;

/**
 * Like inChunks, for lead ids. A chunk that comes back with RESPONSE_CAP rows may have been truncated, so it is re-run in
 * smaller pieces (per 10 leads, then per lead). One lead that alone fills the cap throws: truncating silently is worse.
 */
export async function inLeadChunks<T>(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string): Promise<T[]> {
  const settle = async (chunk: string[]): Promise<T[]> => {
    const r = await run(chunk);
    if (r.error) throw new Error(`${label}: ${r.error.message}`);
    const rows = r.data ?? [];
    if (rows.length < RESPONSE_CAP) return rows;
    if (chunk.length === 1) throw new Error(`${label}: one lead has ${RESPONSE_CAP}+ rows`);
    const size = chunk.length > 10 ? 10 : 1;
    const parts: string[][] = [];
    for (let i = 0; i < chunk.length; i += size) parts.push(chunk.slice(i, i + size));
    return (await Promise.all(parts.map(settle))).flat();
  };
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += FIELD_CHUNK) chunks.push(ids.slice(i, i + FIELD_CHUNK));
  return (await Promise.all(chunks.map(settle))).flat();
}

/** Leads of a workspace with their best candidate. Runs as the user, so RLS decides what the closer sees. */
export async function listLeads(db: SupabaseClient, workspaceId: string): Promise<LeadListItem[]> {
  const leads: LeadRow[] = [];
  for (let from = 0; from < LEADS_MAX; from += PAGE) {
    const { data: page, error } = await db
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("last_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, Math.min(from + PAGE, LEADS_MAX) - 1);
    if (error) throw new Error(`listLeads: ${error.message}`);
    const rows = (page ?? []) as LeadRow[];
    leads.push(...rows);
    if (rows.length < PAGE) break;
  }
  if (leads.length === 0) return [];

  const bestIds = leads.map((l) => l.best_candidate_id).filter((x): x is string => Boolean(x));
  const agentIds = [...new Set(leads.map((l) => l.origin_agent_id).filter((x): x is string => Boolean(x)))];
  const importIds = [...new Set(leads.map((l) => l.origin_import_id).filter((x): x is string => Boolean(x)))];
  const bareIds = leads.filter((l) => !l.best_candidate_id).map((l) => l.id);

  const [candRows, agentRows, checkRows, importRows, fieldRows] = await Promise.all([
    inChunks<Record<string, unknown>>(bestIds, (c) => db.from("research_candidates").select(CANDIDATE_COLUMNS).in("id", c) as never, "listLeads candidates"),
    inChunks<Record<string, unknown>>(agentIds, (c) => db.from("agents").select("id, name").in("id", c) as never, "listLeads agents"),
    inChunks<unknown>(bestIds, (c) => db.from("research_checks").select(CHECK_SELECT).in("candidate_id", c) as never, "listLeads checks"),
    inChunks<Record<string, unknown>>(importIds, (c) => db.from("lead_imports").select("id, list_name").in("id", c) as never, "listLeads imports"),
    inLeadChunks<LeadFieldRow>(
      bareIds,
      (c) => db.from("lead_fields").select(LEAD_FIELD_COLUMNS).in("lead_id", c).in("field", DISPLAY_FIELDS) as never,
      "listLeads fields",
    ),
  ]);
  const importName = new Map(importRows.map((r) => [r.id as string, r.list_name as string]));
  const fieldsBy = new Map<string, LeadFieldRow[]>();
  for (const f of fieldRows) fieldsBy.set(f.lead_id, [...(fieldsBy.get(f.lead_id) ?? []), f]);

  const candById = new Map(candRows.map((r) => [r.id as string, normalizeCandidate(r)]));
  const agentName = new Map(agentRows.map((a) => [a.id as string, a.name as string]));
  const proofBy = new Map<string, number>();
  for (const c of toChecks(checkRows)) {
    if (c.result === "ok" && c.evidence.length > 0) proofBy.set(c.candidate_id, (proofBy.get(c.candidate_id) ?? 0) + 1);
  }

  const items: LeadListItem[] = [];
  for (const lead of leads) {
    let best: CandidateRow | null = null;
    if (lead.best_candidate_id) {
      best = candById.get(lead.best_candidate_id) ?? null;
      if (!best) continue; // not visible (or gone): skip rather than crash
    }
    items.push({
      lead,
      best,
      display: displayOf(best, best ? [] : (fieldsBy.get(lead.id) ?? [])),
      agentName: lead.origin_agent_id ? (agentName.get(lead.origin_agent_id) ?? null) : null,
      importName: lead.origin_import_id ? (importName.get(lead.origin_import_id) ?? null) : null,
      proofOk: best ? (proofBy.get(best.id) ?? 0) : 0,
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

  // Each chunk is ordered by the database, the concatenation is not: sort the merged rows by created_at.
  const rawChecks = await inChunks<Record<string, unknown>>(
    candidates.map((c) => c.id),
    (c) => db.from("research_checks").select(CHECK_SELECT).in("candidate_id", c).order("created_at", { ascending: true }) as never,
    "getLead checks",
  );
  rawChecks.sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)));
  const checks = toChecks(rawChecks);

  // All values of the lead, oldest first. A lead has a few dozen values at most (imports write <= 11 kinds per list); the
  // range only makes PostgREST's 1000-row cap explicit, it is not a pager: a lead with more than 1000 values would be cut.
  const { data: fieldRows, error: fErr } = await db
    .from("lead_fields")
    .select(LEAD_FIELD_COLUMNS)
    .eq("lead_id", id)
    .order("seen_at", { ascending: true })
    .range(0, 999);
  if (fErr) throw new Error(`getLead fields: ${fErr.message}`);
  const fields = (fieldRows ?? []) as LeadFieldRow[];
  const importIds = [...new Set(fields.map((f) => (f.source === "import" ? f.source_ref : null)).concat(lead.origin_import_id).filter((x): x is string => Boolean(x)))];
  const importNames: Record<string, string> = {};
  for (const r of await inChunks<Record<string, unknown>>(importIds, (c) => db.from("lead_imports").select("id, list_name").in("id", c) as never, "getLead imports")) {
    importNames[r.id as string] = r.list_name as string;
  }
  // The queue row is the sender's (RLS): a closer reads none, so the page simply shows no next-step line.
  const { data: q, error: qErr } = await db.from("qualifier_queue").select("next_step, done_reason").eq("lead_id", id).maybeSingle();
  if (qErr) throw new Error(`getLead queue: ${qErr.message}`);
  const queue = q ? { next_step: String(q.next_step), done_reason: (q.done_reason as string | null) ?? null } : null;
  return { lead, agentName, candidates, checks, fields, importNames, queue };
}

/** The newest e-mail hand-off brief of the lead's candidates (the closer_brief jsonb as stored), or null. Parse it before use. */
export async function emailBriefOf(db: SupabaseClient, leadId: string): Promise<unknown | null> {
  const { data: cands, error: cErr } = await db.from("research_candidates").select("id").eq("lead_id", leadId).limit(100);
  if (cErr) throw new Error(`emailBriefOf candidates: ${cErr.message}`);
  const ids = (cands ?? []).map((c) => c.id as string);
  if (ids.length === 0) return null;
  const { data, error } = await db
    .from("email_prospects")
    .select("closer_brief")
    .in("candidate_id", ids)
    .not("closer_brief", "is", null)
    .order("closer_brief_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`emailBriefOf: ${error.message}`);
  return data?.closer_brief ?? null;
}
