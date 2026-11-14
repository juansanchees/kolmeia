import { aiCapErrorFrom } from "@/lib/ai/errors";
import type { AiCallRecord, AiReservation } from "@/lib/ai/gateway";
import { DEFAULT_DAILY_CAP_USD } from "@/lib/ai/gateway";
import type { Dedupable } from "@/lib/research/dedupe";
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
} from "@/lib/research/rows";
import type { CheckWithEvidence, NewRun, ResearchStore } from "@/lib/research/store";
import { as, type TestDb } from "../db/helpers";

const JSON_COLS = new Set(["questions", "answers", "adjustments", "plan", "progress", "limits_notes"]);

/**
 * Test store: same operations as SupabaseResearchStore, as plain SQL run as the `authenticated` role with the
 * user's JWT claim, so RLS, column grants and triggers apply exactly as they would through PostgREST.
 */
export class SqlResearchStore implements ResearchStore {
  constructor(
    private readonly db: TestDb,
    private readonly userId: string,
  ) {}

  private q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.db.query<T>(as(this.userId), sql, params);
  }

  private async update(table: string, id: string, patch: Record<string, unknown>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}${JSON_COLS.has(k) ? "::jsonb" : ""}`).join(", ");
    const values = keys.map((k) => (JSON_COLS.has(k) && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]));
    await this.q(`update public.${table} set ${sets} where id = $1`, [id, ...values]);
  }

  async createRun(r: NewRun): Promise<string> {
    const rows = await this.q<{ id: string }>(
      `insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, max_candidates, max_cost_usd, max_minutes${r.setupAgentId ? ", setup_agent_id" : ""})
       values ($1,$2,$3,$4,$5,$6,$7,$8${r.setupAgentId ? ",$9" : ""}) returning id`,
      [r.workspaceId, r.title, r.requestText, r.regionText, r.rigor, r.maxCandidates, r.maxCostUsd, r.maxMinutes, ...(r.setupAgentId ? [r.setupAgentId] : [])],
    );
    return rows[0].id;
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const rows = await this.q(`select ${RUN_COLUMNS} from public.research_runs where id = $1`, [runId]);
    if (!rows[0]) return null;
    const r = rows[0];
    for (const k of ["approved_at", "started_at", "finished_at", "created_at"]) {
      if (r[k] instanceof Date) r[k] = (r[k] as Date).toISOString();
    }
    return normalizeRun(r);
  }

  updateRun(runId: string, patch: RunPatch): Promise<void> {
    return this.update("research_runs", runId, patch);
  }

  async claimStep(runId: string, holder: string, seconds: number): Promise<boolean> {
    const r = await this.q<{ ok: boolean }>("select public.claim_research_step($1,$2,$3) as ok", [runId, holder, seconds]);
    return r[0].ok;
  }

  async releaseStep(runId: string, holder: string): Promise<void> {
    await this.q("select public.release_research_step($1,$2)", [runId, holder]);
  }

  async getProfile(workspaceId: string): Promise<ProfileInput> {
    const r = await this.q<NonNullable<ProfileInput>>(
      "select what_we_do, service_area, wanted_work, good_customer, not_wanted from public.company_profiles where workspace_id = $1",
      [workspaceId],
    );
    return r[0] ?? null;
  }

  listSources(runId: string): Promise<SourceRow[]> {
    return this.q<SourceRow>("select id, run_id, kind, title, url, status, note from public.research_sources where run_id = $1 order by created_at, id", [runId]);
  }

  async insertSources(workspaceId: string, rows: SourceInsert[]): Promise<void> {
    for (const s of rows) {
      await this.q(
        "insert into public.research_sources (workspace_id, run_id, kind, title, url, status, note) values ($1,$2,$3,$4,$5,$6,$7)",
        [workspaceId, s.run_id, s.kind, s.title, s.url, s.status, s.note],
      );
    }
  }

  async listCandidates(runId: string): Promise<CandidateRow[]> {
    const rows = await this.q(`select ${CANDIDATE_COLUMNS} from public.research_candidates where run_id = $1 order by created_at, name`, [runId]);
    return rows.map((r) => {
      if (r.verified_at instanceof Date) r.verified_at = (r.verified_at as Date).toISOString();
      return normalizeCandidate(r);
    });
  }

  async insertCandidates(workspaceId: string, runId: string, rows: CandidateInsert[]): Promise<CandidateRow[]> {
    const out: CandidateRow[] = [];
    for (const c of rows) {
      const r = await this.q(
        `insert into public.research_candidates (workspace_id, run_id, name, name_key, city, state, region, website, phone, company_type, size_note, notes,
           entry_path, found_at_url, found_at_title, found_at_excerpt, found_at_seen_at, phone_source_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict (run_id, name_key) do nothing returning ${CANDIDATE_COLUMNS}`,
        [
          workspaceId, runId, c.name, c.name_key, c.city, c.state, c.region, c.website, c.phone, c.company_type, c.size_note, c.notes,
          c.entry_path, c.found_at_url, c.found_at_title, c.found_at_excerpt, c.found_at_seen_at, c.phone_source_url,
        ],
      );
      if (r[0]) out.push(normalizeCandidate(r[0]));
    }
    return out;
  }

  updateCandidate(candidateId: string, patch: CandidatePatch): Promise<void> {
    return this.update("research_candidates", candidateId, patch);
  }

  async addCheck(c: CheckInsert): Promise<void> {
    await this.q("select public.add_research_check($1,$2,$3,$4,$5,$6::jsonb)", [
      c.candidateId,
      c.kind,
      c.pass,
      c.result,
      c.summary,
      JSON.stringify(c.evidence.map((e) => ({ url: e.url, title: e.title, excerpt: e.excerpt, ...(e.seenAt ? { seen_at: e.seenAt } : {}) }))),
    ]);
  }

  async listChecks(runId: string): Promise<CheckWithEvidence[]> {
    const checks = await this.q<Omit<CheckWithEvidence, "evidence">>(
      "select id, candidate_id, kind, pass, result, summary from public.research_checks where run_id = $1 order by created_at, id",
      [runId],
    );
    const ev = await this.q<{ check_id: string; url: string; title: string; excerpt: string; seen_at: string }>(
      `select e.check_id, e.url, e.title, e.excerpt, e.seen_at from public.research_evidence e
       join public.research_checks k on k.id = e.check_id where k.run_id = $1 order by e.created_at, e.id`,
      [runId],
    );
    return checks.map((k) => ({
      ...k,
      evidence: ev.filter((e) => e.check_id === k.id).map(({ url, title, excerpt, seen_at }) => ({ url, title, excerpt, seen_at })),
    }));
  }

  async createList(runId: string, name: string): Promise<string> {
    const r = await this.q<{ id: string }>("select public.create_research_list($1,$2) as id", [runId, name]);
    return r[0].id;
  }

  async insertJobs(runId: string, rows: JobInsert[]): Promise<void> {
    if (!rows.length) return;
    await this.q("select public.add_research_jobs($1, $2::jsonb)", [runId, JSON.stringify(rows)]);
  }

  async listJobs(runId: string): Promise<JobRow[]> {
    const rows = await this.q(`select ${JOB_COLUMNS} from public.research_jobs where run_id = $1 order by created_at, id`, [runId]);
    return rows.map(normalizeJob);
  }

  async knownCompanies(runId: string, workspaceId: string): Promise<Dedupable[]> {
    return this.q<Dedupable>(
      `select coalesce(c.name, (select f.value from public.lead_fields f where f.lead_id = l.id and f.field = 'name' and f.status <> 'refuted' order by f.created_at, f.id limit 1)) as name,
              case when c.id is not null then c.website else (select f.value from public.lead_fields f where f.lead_id = l.id and f.field = 'website' and f.status <> 'refuted' order by f.created_at, f.id limit 1) end as website,
              case when c.id is not null then c.phone else (select f.value from public.lead_fields f where f.lead_id = l.id and f.field = 'phone' and f.status <> 'refuted' order by f.created_at, f.id limit 1) end as phone
         from public.leads l left join public.research_candidates c on c.id = l.best_candidate_id
        where l.workspace_id = $1 and l.origin_run_id is distinct from $2
        order by l.last_seen_at desc, l.id limit 2000`,
      [workspaceId, runId],
    ).then((rows) => rows.filter((r) => r.name));
  }

  async reserve(r: AiReservation): Promise<string> {
    try {
      const rows = await this.q<{ id: string }>("select public.reserve_ai_call($1,$2,$3,$4,$5,$6,$7,$8) as id", [
        r.workspaceId,
        r.runId,
        r.task,
        r.model,
        r.promptVersion,
        r.reserveUsd,
        r.userDailyCapUsd,
        r.globalDailyCapUsd,
      ]);
      return rows[0].id;
    } catch (e) {
      throw aiCapErrorFrom((e as Error).message) ?? e;
    }
  }

  async settle(id: string, row: AiCallRecord): Promise<void> {
    await this.q("select public.settle_ai_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      id,
      row.status,
      row.usage.inputTokens,
      row.usage.outputTokens,
      row.usage.cacheReadTokens,
      row.usage.cacheWriteTokens,
      row.usage.webSearches,
      row.usage.webFetches,
      row.costUsd,
      row.error,
      row.durationMs,
    ]);
  }

  async dailyCapUsd(workspaceId: string): Promise<number> {
    const r = await this.q<{ ai_daily_cap_usd: string }>("select ai_daily_cap_usd from public.workspace_settings where workspace_id = $1", [workspaceId]);
    return num(r[0]?.ai_daily_cap_usd) ?? DEFAULT_DAILY_CAP_USD;
  }

  async spentTodayUsd(workspaceId: string): Promise<number> {
    const r = await this.q<{ s: string }>("select public.ai_spend_today($1) as s", [workspaceId]);
    return num(r[0].s) ?? 0;
  }

  async record(row: AiCallRecord): Promise<void> {
    await this.q(
      `insert into public.ai_calls (workspace_id, run_id, task, model, prompt_version, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, web_searches, web_fetches, cost_usd, status, error, duration_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        row.workspaceId,
        row.runId,
        row.task,
        row.model,
        row.promptVersion,
        row.usage.inputTokens,
        row.usage.outputTokens,
        row.usage.cacheReadTokens,
        row.usage.cacheWriteTokens,
        row.usage.webSearches,
        row.usage.webFetches,
        row.costUsd,
        row.status,
        row.error,
        row.durationMs,
      ],
    );
  }
}
