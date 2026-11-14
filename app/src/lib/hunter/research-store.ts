import "server-only";
/* eslint-disable @typescript-eslint/no-unused-vars -- the refused methods keep the ResearchStore signature */
import { aiCapErrorFrom } from "@/lib/ai/errors";
import type { AiCallRecord, AiReservation } from "@/lib/ai/gateway";
import type { ProfileInput } from "@/lib/ai/prompts/shared";
import type { Dedupable } from "@/lib/research/dedupe";
import {
  normalizeCandidate,
  normalizeJob,
  normalizeRun,
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
import type { RpcFn } from "./rpc";

const NOT_ON_PATH = "not_on_hunter_path";

/**
 * The research store of a Caçador run: no user session, every call is a token-gated `hunter_*` function scoped to one
 * agent run and to this tick's step lease (migration 0010). The unchanged engine drives it.
 *
 * The engine names a candidate without its run (updateCandidate, addCheck), but the hunter functions need the run:
 * the store remembers which run each candidate it listed or inserted belongs to.
 */
export class HunterResearchStore implements ResearchStore {
  private readonly runOfCandidate = new Map<string, string>();
  private readonly runOfWorkspace = new Map<string, string>();

  constructor(
    private readonly rpc: RpcFn,
    private readonly tickId: string,
  ) {}

  private call(fn: string, runId: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.rpc(fn, { p_tick: this.tickId, p_run: runId, ...extra });
  }

  private runOf(candidateId: string): string {
    const run = this.runOfCandidate.get(candidateId);
    if (!run) throw new Error("unknown_candidate");
    return run;
  }

  createRun(_r: NewRun): Promise<string> {
    return Promise.reject(new Error(NOT_ON_PATH));
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const r = (await this.call("hunter_get_run", runId)) as Record<string, unknown> | null;
    const run = r ? normalizeRun(r) : null;
    if (run) this.runOfWorkspace.set(run.workspace_id, run.id);
    return run;
  }

  async updateRun(runId: string, patch: RunPatch): Promise<void> {
    await this.call("hunter_update_run", runId, { p_patch: patch });
  }

  async claimStep(runId: string, holder: string, seconds: number): Promise<boolean> {
    if (holder !== this.tickId) throw new Error("holder_is_not_the_tick");
    return (await this.call("hunter_claim_step", runId, { p_seconds: seconds })) === true;
  }

  async releaseStep(runId: string, holder: string): Promise<void> {
    if (holder !== this.tickId) throw new Error("holder_is_not_the_tick");
    await this.call("hunter_release_step", runId);
  }

  async getProfile(workspaceId: string): Promise<ProfileInput> {
    // The hunter function reads the profile through the run (never by workspace id): use the run loaded for it.
    const runId = this.runOfWorkspace.get(workspaceId);
    if (!runId) throw new Error("unknown_workspace");
    return ((await this.call("hunter_profile", runId)) as ProfileInput) ?? null;
  }

  async listSources(runId: string): Promise<SourceRow[]> {
    return (await this.call("hunter_sources", runId)) as SourceRow[];
  }

  async insertSources(_workspaceId: string, rows: SourceInsert[]): Promise<void> {
    const byRun = new Map<string, SourceInsert[]>();
    for (const r of rows) byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), r]);
    for (const [runId, list] of byRun) await this.call("hunter_add_sources", runId, { p_rows: list });
  }

  async listCandidates(runId: string): Promise<CandidateRow[]> {
    const rows = ((await this.call("hunter_candidates", runId)) as Record<string, unknown>[]).map(normalizeCandidate);
    for (const c of rows) this.runOfCandidate.set(c.id, runId);
    return rows;
  }

  async insertCandidates(_workspaceId: string, runId: string, rows: CandidateInsert[]): Promise<CandidateRow[]> {
    if (!rows.length) return [];
    const out = ((await this.call("hunter_add_candidates", runId, { p_rows: rows })) as Record<string, unknown>[]).map(normalizeCandidate);
    for (const c of out) this.runOfCandidate.set(c.id, runId);
    return out;
  }

  async updateCandidate(candidateId: string, patch: CandidatePatch): Promise<void> {
    await this.call("hunter_update_candidate", this.runOf(candidateId), { p_candidate: candidateId, p_patch: patch });
  }

  async addCheck(c: CheckInsert): Promise<void> {
    await this.call("hunter_add_check", this.runOf(c.candidateId), {
      p_candidate: c.candidateId,
      p_kind: c.kind,
      p_pass: c.pass,
      p_result: c.result,
      p_summary: c.summary,
      p_evidence: c.evidence.map((e) => ({ url: e.url, title: e.title, excerpt: e.excerpt, ...(e.seenAt ? { seen_at: e.seenAt } : {}) })),
    });
  }

  async listChecks(runId: string): Promise<CheckWithEvidence[]> {
    return (await this.call("hunter_checks", runId)) as CheckWithEvidence[];
  }

  createList(_runId: string, _name: string): Promise<string> {
    return Promise.reject(new Error(NOT_ON_PATH));
  }

  async insertJobs(runId: string, rows: JobInsert[]): Promise<void> {
    if (!rows.length) return;
    await this.call("hunter_add_jobs", runId, { p_jobs: rows });
  }

  async listJobs(runId: string): Promise<JobRow[]> {
    return ((await this.call("hunter_jobs", runId)) as Record<string, unknown>[]).map(normalizeJob);
  }

  async knownCompanies(runId: string, _workspaceId: string): Promise<Dedupable[]> {
    return (await this.call("hunter_known_companies", runId)) as Dedupable[];
  }

  // ---------------------------------------------------------------- AiLedger
  dailyCapUsd(_workspaceId: string): Promise<number> {
    return Promise.reject(new Error(NOT_ON_PATH));
  }

  spentTodayUsd(_workspaceId: string): Promise<number> {
    return Promise.reject(new Error(NOT_ON_PATH));
  }

  record(_row: AiCallRecord): Promise<void> {
    return Promise.reject(new Error(NOT_ON_PATH));
  }

  async reserve(r: AiReservation): Promise<string> {
    if (!r.runId) throw new Error(NOT_ON_PATH);
    try {
      return (await this.call("hunter_reserve_ai_call", r.runId, {
        p_task: r.task,
        p_model: r.model,
        p_prompt_version: r.promptVersion,
        p_reserve_usd: r.reserveUsd,
        p_user_cap_usd: r.userDailyCapUsd,
        p_global_cap_usd: r.globalDailyCapUsd,
      })) as string;
    } catch (e) {
      const typed = aiCapErrorFrom(e instanceof Error ? e.message : null);
      if (typed) throw typed;
      throw e;
    }
  }

  async settle(id: string, row: AiCallRecord): Promise<void> {
    if (!row.runId) throw new Error(NOT_ON_PATH);
    await this.call("hunter_settle_ai_call", row.runId, {
      p_id: id,
      p_status: row.status,
      p_input_tokens: row.usage.inputTokens,
      p_output_tokens: row.usage.outputTokens,
      p_cache_read_tokens: row.usage.cacheReadTokens,
      p_cache_write_tokens: row.usage.cacheWriteTokens,
      p_web_searches: row.usage.webSearches,
      p_web_fetches: row.usage.webFetches,
      p_cost_usd: row.costUsd,
      p_error: row.error,
      p_duration_ms: row.durationMs,
    });
  }
}
