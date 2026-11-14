import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiCallRecord, AiReservation } from "@/lib/ai/gateway";
import { DEFAULT_DAILY_CAP_USD } from "@/lib/ai/gateway";
import { reserveAiCallRpc, settleAiCallRpc } from "@/lib/ai/ledger-rpc";
import type { ProfileInput } from "@/lib/ai/prompts/shared";
import {
  CANDIDATE_COLUMNS,
  JOB_COLUMNS,
  RUN_COLUMNS,
  normalizeCandidate,
  normalizeJob,
  normalizeRun,
  num,
  type CandidateInsert,
  type CandidatePatch,
  type CandidateRow,
  type CheckInsert,
  type JobInsert,
  type JobRow,
  type RunPatch,
  type RunRow,
  type SourceInsert,
  type SourceRow,
} from "./rows";
import { inChunks } from "@/lib/leads/queries";
import type { Dedupable } from "./dedupe";
import type { CheckWithEvidence, NewRun, ResearchStore } from "./store";

/** Same limit as hunter_known_companies. */
const KNOWN_LEADS_MAX = 2000;

/** Production store: every call runs with the logged-in user's session (cookie client), so RLS applies (R14). */
export class SupabaseResearchStore implements ResearchStore {
  constructor(private readonly db: SupabaseClient) {}

  private fail(what: string, error: { message: string } | null): never {
    // Never include row data in the error (R10).
    throw new Error(`${what}: ${error?.message ?? "failed"}`);
  }

  async createRun(r: NewRun): Promise<string> {
    const { data, error } = await this.db
      .from("research_runs")
      .insert({
        workspace_id: r.workspaceId,
        title: r.title,
        request_text: r.requestText,
        region_text: r.regionText,
        rigor: r.rigor,
        max_candidates: r.maxCandidates,
        max_cost_usd: r.maxCostUsd,
        max_minutes: r.maxMinutes,
        ...(r.setupAgentId ? { setup_agent_id: r.setupAgentId } : {}),
      })
      .select("id")
      .single();
    if (error || !data) this.fail("createRun", error);
    return data.id as string;
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const { data, error } = await this.db.from("research_runs").select(RUN_COLUMNS).eq("id", runId).maybeSingle();
    if (error) this.fail("getRun", error);
    return data ? normalizeRun(data as Record<string, unknown>) : null;
  }

  async updateRun(runId: string, patch: RunPatch): Promise<void> {
    const { error } = await this.db.from("research_runs").update(patch).eq("id", runId);
    if (error) this.fail("updateRun", error);
  }

  async claimStep(runId: string, holder: string, seconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc("claim_research_step", { p_run: runId, p_holder: holder, p_seconds: seconds });
    if (error) this.fail("claimStep", error);
    return data === true;
  }

  async releaseStep(runId: string, holder: string): Promise<void> {
    const { error } = await this.db.rpc("release_research_step", { p_run: runId, p_holder: holder });
    if (error) this.fail("releaseStep", error);
  }

  async getProfile(workspaceId: string): Promise<ProfileInput> {
    const { data, error } = await this.db
      .from("company_profiles")
      .select("what_we_do, service_area, wanted_work, good_customer, not_wanted")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) this.fail("getProfile", error);
    return (data as ProfileInput) ?? null;
  }

  async listSources(runId: string): Promise<SourceRow[]> {
    const { data, error } = await this.db
      .from("research_sources")
      .select("id, run_id, kind, title, url, status, note")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (error) this.fail("listSources", error);
    return (data ?? []) as SourceRow[];
  }

  async insertSources(workspaceId: string, rows: SourceInsert[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.from("research_sources").insert(rows.map((r) => ({ workspace_id: workspaceId, ...r })));
    if (error) this.fail("insertSources", error);
  }

  async listCandidates(runId: string): Promise<CandidateRow[]> {
    const { data, error } = await this.db
      .from("research_candidates")
      .select(CANDIDATE_COLUMNS)
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (error) this.fail("listCandidates", error);
    return (data ?? []).map((r) => normalizeCandidate(r as Record<string, unknown>));
  }

  async insertCandidates(workspaceId: string, runId: string, rows: CandidateInsert[]): Promise<CandidateRow[]> {
    if (!rows.length) return [];
    // ON CONFLICT (run_id, name_key) DO NOTHING: a duplicate that slipped past the in-code dedupe is skipped.
    const { data, error } = await this.db
      .from("research_candidates")
      .upsert(rows.map((r) => ({ workspace_id: workspaceId, run_id: runId, ...r })), { onConflict: "run_id,name_key", ignoreDuplicates: true })
      .select(CANDIDATE_COLUMNS);
    if (error) this.fail("insertCandidates", error);
    return (data ?? []).map((r) => normalizeCandidate(r as Record<string, unknown>));
  }

  async updateCandidate(candidateId: string, patch: CandidatePatch): Promise<void> {
    const { error } = await this.db.from("research_candidates").update(patch).eq("id", candidateId);
    if (error) this.fail("updateCandidate", error);
  }

  async addCheck(c: CheckInsert): Promise<void> {
    const { error } = await this.db.rpc("add_research_check", {
      p_candidate: c.candidateId,
      p_kind: c.kind,
      p_pass: c.pass,
      p_result: c.result,
      p_summary: c.summary,
      p_evidence: c.evidence.map((e) => ({ url: e.url, title: e.title, excerpt: e.excerpt, ...(e.seenAt ? { seen_at: e.seenAt } : {}) })),
    });
    if (error) this.fail("addCheck", error);
  }

  async listChecks(runId: string): Promise<CheckWithEvidence[]> {
    const { data, error } = await this.db
      .from("research_checks")
      .select("id, candidate_id, kind, pass, result, summary, research_evidence(url, title, excerpt, seen_at)")
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (error) this.fail("listChecks", error);
    return (data ?? []).map((r) => {
      const { research_evidence, ...rest } = r as Record<string, unknown> & { research_evidence: CheckWithEvidence["evidence"] };
      return { ...(rest as unknown as Omit<CheckWithEvidence, "evidence">), evidence: research_evidence ?? [] };
    });
  }

  async createList(runId: string, name: string): Promise<string> {
    const { data, error } = await this.db.rpc("create_research_list", { p_run: runId, p_name: name });
    if (error) this.fail("createList", error);
    return data as string;
  }

  async insertJobs(runId: string, rows: JobInsert[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.rpc("add_research_jobs", { p_run: runId, p_jobs: rows });
    if (error) this.fail("insertJobs", error);
  }

  async listJobs(runId: string): Promise<JobRow[]> {
    const { data, error } = await this.db.from("research_jobs").select(JOB_COLUMNS).eq("run_id", runId).order("created_at", { ascending: true });
    if (error) this.fail("listJobs", error);
    return (data ?? []).map((r) => normalizeJob(r as Record<string, unknown>));
  }

  /** Same list as hunter_known_companies: leads with a best candidate, plus import-only leads (oldest non-refuted values). */
  async knownCompanies(runId: string, workspaceId: string): Promise<Dedupable[]> {
    const { data: leads, error } = await this.db
      .from("leads")
      .select("id, best_candidate_id, origin_run_id, last_seen_at")
      .eq("workspace_id", workspaceId)
      .or(`origin_run_id.is.null,origin_run_id.neq.${runId}`)
      .order("last_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(KNOWN_LEADS_MAX);
    if (error) this.fail("knownCompanies", error);
    const withCand = (leads ?? []).filter((l) => l.best_candidate_id);
    const importOnly = (leads ?? []).filter((l) => !l.best_candidate_id);
    const cands = await inChunks<{ id: string; name: string; website: string | null; phone: string | null }>(
      withCand.map((l) => l.best_candidate_id as string),
      (chunk) => this.db.from("research_candidates").select("id, name, website, phone").in("id", chunk) as never,
      "knownCompanies",
    );
    const byId = new Map(cands.map((c) => [c.id, c]));
    const fields = await inChunks<{ lead_id: string; field: string; value: string }>(
      importOnly.map((l) => l.id as string),
      (chunk) =>
        this.db
          .from("lead_fields")
          .select("lead_id, field, value")
          .in("lead_id", chunk)
          .in("field", ["name", "website", "phone"])
          .neq("status", "refuted")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true }) as never,
      "knownCompanies",
    );
    const oldest = new Map<string, Record<string, string>>(); // lead -> field -> oldest value
    for (const f of fields) {
      const m = oldest.get(f.lead_id) ?? {};
      if (!(f.field in m)) m[f.field] = f.value;
      oldest.set(f.lead_id, m);
    }
    return (leads ?? []).flatMap((l): Dedupable[] => {
      if (l.best_candidate_id) {
        const c = byId.get(l.best_candidate_id as string);
        return c ? [{ name: c.name, website: c.website ?? null, phone: c.phone ?? null }] : [];
      }
      const m = oldest.get(l.id as string);
      return m?.name ? [{ name: m.name, website: m.website ?? null, phone: m.phone ?? null }] : [];
    });
  }

  // ---------------------------------------------------------------- AiLedger
  async dailyCapUsd(workspaceId: string): Promise<number> {
    const { data, error } = await this.db.from("workspace_settings").select("ai_daily_cap_usd").eq("workspace_id", workspaceId).maybeSingle();
    if (error) this.fail("dailyCapUsd", error);
    return num(data?.ai_daily_cap_usd) ?? DEFAULT_DAILY_CAP_USD;
  }

  async spentTodayUsd(workspaceId: string): Promise<number> {
    const { data, error } = await this.db.rpc("ai_spend_today", { p_workspace: workspaceId });
    if (error) this.fail("spentTodayUsd", error);
    return num(data) ?? 0;
  }

  /** Atomic check-and-reserve in the database (reserve_ai_call). Cap refusals come back as typed AiErrors. */
  reserve(r: AiReservation): Promise<string> {
    return reserveAiCallRpc(this.db, r);
  }

  settle(id: string, row: AiCallRecord): Promise<void> {
    return settleAiCallRpc(this.db, id, row);
  }

  /** Legacy direct insert. After migration 0004 the database refuses it; kept for the AiLedger interface only. */
  async record(row: AiCallRecord): Promise<void> {
    const { error } = await this.db.from("ai_calls").insert({
      workspace_id: row.workspaceId,
      run_id: row.runId,
      task: row.task,
      model: row.model,
      prompt_version: row.promptVersion,
      input_tokens: row.usage.inputTokens,
      output_tokens: row.usage.outputTokens,
      cache_read_tokens: row.usage.cacheReadTokens,
      cache_write_tokens: row.usage.cacheWriteTokens,
      web_searches: row.usage.webSearches,
      web_fetches: row.usage.webFetches,
      cost_usd: row.costUsd,
      status: row.status,
      error: row.error,
      duration_ms: row.durationMs,
    });
    if (error) this.fail("recordAiCall", error);
  }
}
