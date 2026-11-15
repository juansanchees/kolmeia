import "server-only";
import { AiError, isAiError, type AiErrorCode } from "@/lib/ai/errors";
import type { AiContext, WebReport } from "@/lib/ai/gateway";
import {
  askQuestions,
  collectCandidates,
  discoverSources,
  secondPass,
  verifyCompanies,
  type FoundJob,
  type FoundSource,
  type VerifiedCompany,
} from "@/lib/ai/tasks";
import { minReserveUsdFor, writePlan } from "@/lib/ai/tasks";
import { WEB_LIMITS_BY_RIGOR } from "@/lib/ai/routing";
import type { AiTransport } from "@/lib/ai/types";
import { dedupe, nameKey } from "./dedupe";
import { approach, temperature } from "./rules";
import type { CandidatePatch, CandidateRow, JobInsert, RunPatch, RunRow, SourceInsert } from "./rows";
import type { CheckWithEvidence, ResearchStore } from "./store";
import {
  CHECKS_BY_RIGOR,
  SECOND_PASS_BY_RIGOR,
  type CheckKind,
  type LimitNote,
  type Progress,
  type Rigor,
  type SeenItem,
  type Stage,
  type StageCounts,
} from "./types";

// The research state machine. One call to `advance` = one bounded step (fits the route's maxDuration), driven by the
// open page. State lives in research_runs; nothing runs in the background.

export type EngineDeps = {
  store: ResearchStore;
  transport: AiTransport | null;
  now?: () => Date;
  /** Companies per verify / second-pass call. */
  batchSize?: number;
};

export type StepOutcome =
  | { kind: "stepped"; did: string; run: RunRow }
  | { kind: "idle"; run: RunRow }
  | { kind: "busy" }
  | { kind: "not_found" }
  | { kind: "ai_error"; code: AiErrorCode; run: RunRow };

export const LEASE_SECONDS = 330; // a bit more than the route's maxDuration (300 s)
const MAX_COLLECT_ROUNDS = 4;
/** Rounds in a row without a new company before the collection gives up (each next round tries other searches). */
const MAX_EMPTY_ROUNDS = 2;
const COLLECT_PER_ROUND = 10;
const QUERIES_KEEP = 40;
const MAX_ERROR_STREAK = 3;
const SEEN_KEEP = 12;
const MERGED_KEEP = 30;
/** Known lead names an agent run tells the collect prompt to avoid (the dedupe against LEADS is the real filter). */
export const KNOWN_NAMES_MAX = 150;

/** Does this run have work the page should ask the server to do? */
export function needsAdvance(run: Pick<RunRow, "status" | "questions" | "plan">): boolean {
  switch (run.status) {
    case "questions":
      return run.questions === null;
    case "plan":
      return run.plan === null;
    case "ready":
    case "running":
      return true;
    default:
      return false;
  }
}

/** Takes the step lease, does one step, releases the lease. Two tabs never run the same step twice. */
export async function advance(deps: EngineDeps, runId: string, holder: string): Promise<StepOutcome> {
  const claimed = await deps.store.claimStep(runId, holder, LEASE_SECONDS);
  if (!claimed) {
    const exists = await deps.store.getRun(runId);
    return exists ? { kind: "busy" } : { kind: "not_found" };
  }
  try {
    const run = await deps.store.getRun(runId);
    if (!run) return { kind: "not_found" };
    return await step(deps, run);
  } finally {
    await deps.store.releaseStep(runId, holder);
  }
}

/**
 * `holdBackUsd`: budget a stage must leave untouched (modo econômico). Discover and collect keep enough for one
 * smallest verify call, so a run whose web calls shrink to fit a small cap can still check what it found.
 */
function aiContext(deps: EngineDeps, run: RunRow, withRunBudget: boolean, holdBackUsd = 0): AiContext {
  return {
    workspaceId: run.workspace_id,
    runId: run.id,
    ledger: deps.store,
    transport: deps.transport,
    runBudget: withRunBudget ? { spentUsd: run.spent_cost_usd, maxUsd: Math.max(0, run.max_cost_usd - holdBackUsd) } : undefined,
  };
}

const verifyRoom = (run: RunRow) => minReserveUsdFor("verify", run.rigor);

async function reload(deps: EngineDeps, runId: string): Promise<RunRow> {
  const r = await deps.store.getRun(runId);
  if (!r) throw new Error("run disappeared");
  return r;
}

async function step(deps: EngineDeps, run: RunRow): Promise<StepOutcome> {
  const now = deps.now ?? (() => new Date());
  try {
    switch (run.status) {
      case "questions": {
        if (run.questions !== null) return { kind: "idle", run };
        const profile = await deps.store.getProfile(run.workspace_id);
        const { data } = await askQuestions(aiContext(deps, run, false), {
          profile,
          request: run.request_text,
          region: run.region_text,
        });
        const progress: Progress = { ...run.progress, understood: data.understood, places: data.places, errorStreak: 0 };
        await deps.store.updateRun(run.id, data.questions.length
          ? { questions: data.questions, progress }
          : { questions: [], progress, status: "plan" });
        return { kind: "stepped", did: "questions", run: await reload(deps, run.id) };
      }
      case "plan": {
        if (run.plan !== null) return { kind: "idle", run };
        const profile = await deps.store.getProfile(run.workspace_id);
        const { data } = await writePlan(aiContext(deps, run, false), {
          profile,
          request: run.request_text,
          region: run.region_text,
          rigor: run.rigor,
          questions: run.questions ?? [],
          answers: run.answers,
          adjustments: run.adjustments,
        });
        await deps.store.updateRun(run.id, { plan: data, progress: { ...run.progress, errorStreak: 0 } });
        return { kind: "stepped", did: "plan", run: await reload(deps, run.id) };
      }
      case "ready": {
        // P4: only an approved plan reaches "ready" (database trigger); now the search starts. started_at is
        // stamped by the database trigger (finding 7), never sent from here.
        await deps.store.updateRun(run.id, {
          status: "running",
          progress: { ...run.progress, stage: "discover_sources", collectRounds: 0, errorStreak: 0, seen: [] },
        });
        return { kind: "stepped", did: "start", run: await reload(deps, run.id) };
      }
      case "running":
        return await runningStep(deps, run, now);
      default:
        return { kind: "idle", run };
    }
  } catch (e) {
    // Finding 6: any failure (database write, bug, network) goes through the same error-streak / skip-stage logic,
    // so a run never stays stuck in "running" and a retried step does not loop forever.
    const err = isAiError(e) ? e : new AiError("transport", e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "unknown error");
    return handleAiError(deps, run, err, now);
  }
}

async function handleAiError(deps: EngineDeps, run: RunRow, e: AiError, now: () => Date): Promise<StepOutcome> {
  const fresh = await reload(deps, run.id);
  switch (e.code) {
    case "not_configured":
    case "no_access":
      return { kind: "ai_error", code: e.code, run: fresh };
    case "daily_cap":
    case "user_cap":
    case "global_cap":
      if (fresh.status === "running") {
        await deps.store.updateRun(run.id, { status: "paused", progress: { ...fresh.progress, pauseReason: e.code } });
      }
      return { kind: "ai_error", code: e.code, run: await reload(deps, run.id) };
    case "run_cap":
      if (fresh.status === "running") await finalize(deps, fresh, now, "cost");
      return { kind: "ai_error", code: e.code, run: await reload(deps, run.id) };
    case "run_time":
      if (fresh.status === "running") await finalize(deps, fresh, now, "time");
      return { kind: "ai_error", code: e.code, run: await reload(deps, run.id) };
    default: {
      // refused / invalid_output / truncated / transport: retry on the next step, give up after a few.
      const streak = (fresh.progress.errorStreak ?? 0) + 1;
      const progress: Progress = { ...fresh.progress, errorStreak: streak, lastError: e.code };
      if (streak < MAX_ERROR_STREAK) {
        await deps.store.updateRun(run.id, { progress });
      } else if (fresh.status === "questions" || fresh.status === "plan") {
        await deps.store.updateRun(run.id, { status: "failed", error: e.code, progress });
      } else if (fresh.status === "running") {
        await skipStage(deps, fresh, progress, now);
      }
      return { kind: "ai_error", code: e.code, run: await reload(deps, run.id) };
    }
  }
}

/** After repeated failures in a running stage, move on instead of looping forever (and say so in the limits). */
async function skipStage(deps: EngineDeps, run: RunRow, progress: Progress, now: () => Date) {
  const stage = progress.stage ?? "discover_sources";
  const reset: Progress = { ...progress, errorStreak: 0 };
  if (stage === "verify" || stage === "second_pass") {
    const batch = await pendingBatch(deps, run, stage);
    for (const c of batch) {
      if (stage === "verify") {
        // add_research_check upserts (one check per candidate, kind and pass), so this is safe to repeat.
        for (const kind of CHECKS_BY_RIGOR[run.rigor]) {
          await deps.store.addCheck({ candidateId: c.id, kind, pass: 1, result: "unknown", summary: FAILED_CHECK, evidence: [] });
        }
        await deps.store.updateCandidate(c.id, { verified_at: now().toISOString(), temperature: "cold", approach: "call" });
      } else {
        await deps.store.updateCandidate(c.id, { second_pass: "unsure" });
      }
    }
    await deps.store.updateRun(run.id, { progress: reset });
    return;
  }
  const next: Stage = stage === "discover_sources" ? "collect" : stage === "collect" ? "verify" : "finalize";
  await deps.store.updateRun(run.id, { progress: { ...reset, stage: next } });
}

const FAILED_CHECK = "A IA falhou ao checar esta empresa; ficou sem confirmação.";
const FOUND_AT = "Achada nesta fonte; checagem a seguir.";
const NOT_RETURNED = "A IA não devolveu esta empresa nesta passada.";

const dropped = (run: RunRow, n: number | undefined) => (run.progress.droppedUrls ?? 0) + (n ?? 0);

type BudgetStage = keyof NonNullable<Progress["budgetHits"]>;
/**
 * Counts a call that used its whole web budget (a normal end of searching, reported in the limits). A call whose
 * budget was shrunk to fit the cost cap is counted in trimmedCalls instead (its note would quote the wrong numbers).
 */
const budgetHits = (run: RunRow, stage: BudgetStage, web: WebReport | undefined): Progress["budgetHits"] =>
  web?.budgetUsed && !web.trimmed ? { ...run.progress.budgetHits, [stage]: (run.progress.budgetHits?.[stage] ?? 0) + 1 } : run.progress.budgetHits;
/** Counts calls whose web budget was shrunk to fit the run's remaining cost cap (modo econômico). */
const trimmedCalls = (run: RunRow, web: WebReport | undefined): number | undefined =>
  web?.trimmed ? (run.progress.trimmedCalls ?? 0) + 1 : run.progress.trimmedCalls;

function jobRows(jobs: FoundJob[] | undefined): JobInsert[] {
  return (jobs ?? []).map((j) => ({
    address: j.address,
    project_name: j.projectName,
    job_type: j.jobType,
    declared_value_usd: j.declaredValueUsd,
    job_date: j.jobDate,
    source_url: j.sourceUrl,
    excerpt: j.excerpt,
    seen_at: j.seenAt,
  }));
}

async function runningStep(deps: EngineDeps, run: RunRow, now: () => Date): Promise<StepOutcome> {
  // P6: time cap, against the trigger-owned started_at (finding 7; the database also refuses AI calls past it).
  const started = Date.parse(run.started_at ?? run.approved_at ?? run.created_at);
  if (Number.isFinite(started) && now().getTime() > started + run.max_minutes * 60_000) {
    await finalize(deps, run, now, "time");
    return { kind: "stepped", did: "finalize_time", run: await reload(deps, run.id) };
  }
  // P6: cost cap (the gateway also refuses a call that would not fit).
  if (run.spent_cost_usd >= run.max_cost_usd) {
    await finalize(deps, run, now, "cost");
    return { kind: "stepped", did: "finalize_cost", run: await reload(deps, run.id) };
  }

  const stage: Stage = run.progress.stage ?? "discover_sources";
  switch (stage) {
    case "discover_sources":
      await discoverStage(deps, run);
      break;
    case "collect":
      await collectStage(deps, run);
      break;
    case "verify":
      await verifyStage(deps, run, now);
      break;
    case "second_pass":
      await secondPassStage(deps, run, now);
      break;
    case "finalize":
      await finalize(deps, run, now, null);
      break;
  }
  const after = await reload(deps, run.id);
  if (after.status === "running") await refreshCounts(deps, after);
  return { kind: "stepped", did: stage, run: await reload(deps, run.id) };
}

// ---------------------------------------------------------------- stages
async function discoverStage(deps: EngineDeps, run: RunRow) {
  const { data, droppedUrls, web } = await discoverSources(aiContext(deps, run, true, verifyRoom(run)), {
    request: run.request_text,
    region: run.region_text,
    plan: run.plan ?? { summary: "", places: [], sourceTypes: [], warnings: [] },
  }, run.rigor);
  const existing = await deps.store.listSources(run.id); // a retried step does not duplicate sources
  await deps.store.insertSources(run.workspace_id, toSourceRows(run.id, data, existing));
  await patchProgress(deps, run, {
    stage: "collect",
    errorStreak: 0,
    droppedUrls: dropped(run, droppedUrls),
    budgetHits: budgetHits(run, "discover_sources", web),
    trimmedCalls: trimmedCalls(run, web),
  });
}

function toSourceRows(runId: string, found: FoundSource[], existing: { url: string | null; title: string }[]): SourceInsert[] {
  const urls = new Set(existing.map((s) => s.url).filter(Boolean));
  const titles = new Set(existing.map((s) => s.title.toLowerCase()));
  const rows: SourceInsert[] = [];
  for (const s of found) {
    if ((s.url && urls.has(s.url)) || (!s.url && titles.has(s.title.toLowerCase()))) continue;
    if (s.url) urls.add(s.url);
    titles.add(s.title.toLowerCase());
    rows.push({ run_id: runId, kind: s.kind, title: s.title, url: s.url, status: s.status, note: s.note });
  }
  return rows;
}

async function collectStage(deps: EngineDeps, run: RunRow) {
  const [existing, sources] = await Promise.all([deps.store.listCandidates(run.id), deps.store.listSources(run.id)]);
  const remaining = run.max_candidates - existing.length;
  const rounds = run.progress.collectRounds ?? 0;
  if (remaining <= 0 || rounds >= MAX_COLLECT_ROUNDS) {
    await patchProgress(deps, run, { stage: "verify", errorStreak: 0 });
    return;
  }
  const profile = await deps.store.getProfile(run.workspace_id);
  // C4: a scheduled agent only brings companies that are not in LEADS yet. A one-off search keeps everything.
  const known = run.agent_id ? await deps.store.knownCompanies(run.id, run.workspace_id) : [];
  let result: Awaited<ReturnType<typeof collectCandidates>>;
  try {
    result = await collectCandidates(aiContext(deps, run, true, verifyRoom(run)), {
      profile,
      request: run.request_text,
      region: run.region_text,
      plan: run.plan ?? { summary: "", places: [], sourceTypes: [], warnings: [] },
      sources: sources.map((s) => ({ title: s.title, url: s.url, status: s.status, note: s.note })),
      knownNames: [...existing.map((c) => c.name), ...known.slice(0, KNOWN_NAMES_MAX).map((c) => c.name)],
      want: Math.min(COLLECT_PER_ROUND, remaining),
      round: rounds + 1,
      queriesTried: run.progress.queries ?? [],
      profileHints: run.profile_hints ?? null,
    }, run.rigor);
  } catch (e) {
    // Another collect round no longer fits the run's cost cap, but checking what was found may: go check it.
    if (isAiError(e) && e.code === "run_cap" && existing.length > 0) {
      await patchProgress(deps, run, { stage: "verify", errorStreak: 0, collectStop: "cost" });
      return;
    }
    throw e;
  }
  const { data, droppedUrls, web } = result;

  const { fresh: freshInRun, mergedInto } = dedupe(existing, data.candidates);
  const { fresh } = known.length ? dedupe(known, freshInRun) : { fresh: freshInRun };
  const alreadyKnown = freshInRun.length - fresh.length;
  const take = fresh.slice(0, remaining);
  // ON CONFLICT (run_id, name_key) DO NOTHING: a retried step does not create the same company twice.
  const inserted = await deps.store.insertCandidates(
    run.workspace_id,
    run.id,
    take.map((c) => ({
      name: c.name,
      name_key: nameKey(c.name),
      city: c.city,
      state: c.state,
      region: c.region,
      website: c.website,
      phone: c.phone,
      phone_source_url: c.phoneSourceUrl,
      company_type: c.companyType,
      size_note: c.sizeNote,
      notes: null,
      entry_path: c.entryPath,
      found_at_url: c.foundAt?.url ?? null,
      found_at_title: c.foundAt?.title || null,
      found_at_excerpt: c.foundAt?.excerpt || null,
      found_at_seen_at: c.foundAt?.seenAt ?? null,
    })),
  );
  const seen: SeenItem[] = inserted.map((row) => ({
    name: row.name,
    verdict: "unknown" as const,
    line: FOUND_AT,
    source: row.found_at_title || row.found_at_url || "",
  }));
  await deps.store.insertSources(run.workspace_id, toSourceRows(run.id, data.sourcesTried, sources));
  await deps.store.insertJobs(run.id, jobRows(data.jobs));

  const total = existing.length + inserted.length;
  const emptyRounds = inserted.length === 0 ? (run.progress.emptyRounds ?? 0) + 1 : 0;
  // An empty round is not the end: the next one is told which searches were already run and tries others. The
  // model's "exhausted" only counts when it did not run out of its web budget first.
  const exhausted = data.exhausted && !web?.budgetUsed;
  const done =
    total >= run.max_candidates || exhausted || emptyRounds >= MAX_EMPTY_ROUNDS || rounds + 1 >= MAX_COLLECT_ROUNDS;
  const merged = [...(run.progress.merged ?? []), ...mergedInto.map((m) => `${m.name} (= ${m.into})`)].slice(0, MERGED_KEEP);
  await patchProgress(deps, run, {
    stage: done ? "verify" : "collect",
    collectRounds: rounds + 1,
    emptyRounds,
    errorStreak: 0,
    seen: [...seen, ...(run.progress.seen ?? [])].slice(0, SEEN_KEEP),
    merged,
    ...(alreadyKnown > 0 ? { alreadyKnown: (run.progress.alreadyKnown ?? 0) + alreadyKnown } : {}),
    droppedUrls: dropped(run, droppedUrls),
    queries: [...(run.progress.queries ?? []), ...(web?.queries ?? [])].slice(-QUERIES_KEEP),
    budgetHits: budgetHits(run, "collect", web),
    trimmedCalls: trimmedCalls(run, web),
    ...(emptyRounds >= MAX_EMPTY_ROUNDS && total < run.max_candidates ? { collectStop: "empty" as const } : {}),
  });
}

async function pendingBatch(deps: EngineDeps, run: RunRow, stage: "verify" | "second_pass"): Promise<CandidateRow[]> {
  const size = deps.batchSize ?? 3;
  const candidates = await deps.store.listCandidates(run.id);
  if (stage === "verify") return candidates.filter((c) => !c.verified_at).slice(0, size);
  const checks = await deps.store.listChecks(run.id);
  const dead = new Set(checks.filter((k) => k.pass === 1 && k.kind === "exists_active" && k.result === "no").map((k) => k.candidate_id));
  return candidates.filter((c) => c.verified_at && !c.second_pass && !dead.has(c.id)).slice(0, size);
}

async function verifyStage(deps: EngineDeps, run: RunRow, now: () => Date) {
  const batch = await pendingBatch(deps, run, "verify");
  if (batch.length === 0) {
    await patchProgress(deps, run, { stage: SECOND_PASS_BY_RIGOR[run.rigor] ? "second_pass" : "finalize", errorStreak: 0 });
    return;
  }
  const kinds = CHECKS_BY_RIGOR[run.rigor];
  const profile = await deps.store.getProfile(run.workspace_id);
  const { data, droppedUrls, web } = await verifyCompanies(aiContext(deps, run, true), {
    rigor: run.rigor,
    kinds,
    profile,
    request: run.request_text,
    today: now().toISOString().slice(0, 10),
    companies: batch.map((c) => ({ ref: c.id, name: c.name, city: c.city, state: c.state, website: c.website, phone: c.phone })),
  });
  const byRef = new Map(data.map((v) => [v.ref, v]));
  const seen: SeenItem[] = [];
  for (const c of batch) {
    const v = byRef.get(c.id);
    if (!v) {
      for (const kind of kinds) {
        await deps.store.addCheck({ candidateId: c.id, kind, pass: 1, result: "unknown", summary: NOT_RETURNED, evidence: [] });
      }
      await deps.store.updateCandidate(c.id, { verified_at: now().toISOString(), temperature: "cold", approach: "call" });
      seen.push({ name: c.name, verdict: "unknown", line: NOT_RETURNED, source: "" });
      continue;
    }
    for (const k of v.checks) {
      await deps.store.addCheck({ candidateId: c.id, kind: k.kind, pass: 1, result: k.result, summary: k.summary, evidence: k.evidence });
    }
    await deps.store.updateCandidate(c.id, verifiedPatch(c, v, now));
    seen.push(seenLine(c.name, v.checks));
  }
  await deps.store.insertJobs(run.id, jobRows(data.jobs));
  await patchProgress(deps, run, {
    errorStreak: 0,
    seen: [...seen, ...(run.progress.seen ?? [])].slice(0, SEEN_KEEP),
    droppedUrls: dropped(run, droppedUrls),
    budgetHits: budgetHits(run, "verify", web),
    trimmedCalls: trimmedCalls(run, web),
  });
}

function resultOf(checks: { kind: CheckKind; result: string }[], kind: CheckKind) {
  return (checks.find((k) => k.kind === kind)?.result ?? null) as "ok" | "no" | "unknown" | null;
}

function seenLine(name: string, checks: VerifiedCompany["checks"]): SeenItem {
  const no = checks.find((k) => k.result === "no");
  const ok = checks.find((k) => k.result === "ok" && k.evidence.length);
  const pick = no ?? ok ?? checks[0];
  const verdict: SeenItem["verdict"] = no ? "drop" : checks.every((k) => k.result === "ok") ? "keep" : "unknown";
  return { name, verdict, line: pick?.summary ?? "", source: pick?.evidence[0]?.title || pick?.evidence[0]?.url || "" };
}

export function verifiedPatch(c: CandidateRow, v: VerifiedCompany, now: () => Date): CandidatePatch {
  const website = v.website ?? c.website;
  const phone = v.phone ?? c.phone;
  return {
    verified_at: now().toISOString(),
    website,
    phone,
    // Finding 5: each contact field keeps the page that shows it; no page = shown as unverified.
    phone_source_url: v.phone ? v.phoneSourceUrl : c.phone_source_url,
    public_email: v.publicEmail,
    email_type: v.emailType,
    email_source_url: v.emailSourceUrl,
    rating_source_url: v.ratingSourceUrl,
    permit_count: v.permitCount,
    total_value_usd: v.totalValueUsd,
    last_permit_date: v.lastPermitDate,
    biggest_job_address: v.biggestJobAddress,
    biggest_job_value_usd: v.biggestJobValueUsd,
    biggest_job_type: v.biggestJobType,
    biggest_job_description: v.biggestJobDescription,
    signal_match: v.signalMatch,
    ask_for_name: v.askForName,
    ask_for_title: v.askForTitle,
    name_confidence: v.nameConfidence,
    name_source_url: v.nameSourceUrl,
    name_note: v.nameNote,
    google_rating: v.googleRating,
    review_count: v.reviewCount,
    supplier_portal_url: v.supplierPortalUrl,
    hook: v.hook,
    notes: v.notes,
    temperature: temperature({
      hasWork: resultOf(v.checks, "has_work"),
      existsActive: resultOf(v.checks, "exists_active"),
      biggestJobValueUsd: v.biggestJobValueUsd,
      lastPermitDate: v.lastPermitDate,
      website,
      reviewCount: v.reviewCount,
      now: now(),
    }),
    approach: approach({ isLargeContractor: v.isLargeContractor, supplierPortalUrl: v.supplierPortalUrl, phone, publicEmail: v.publicEmail }),
  };
}

async function secondPassStage(deps: EngineDeps, run: RunRow, now: () => Date) {
  const batch = await pendingBatch(deps, run, "second_pass");
  if (batch.length === 0) {
    await patchProgress(deps, run, { stage: "finalize", errorStreak: 0 });
    return;
  }
  const checks = await deps.store.listChecks(run.id);
  // P5: only identity + evidence (links, titles, excerpts). No result, summary, temperature or hook.
  const companies = batch.map((c) => {
    const urls = new Set<string>();
    const evidence: { url: string; title: string; excerpt: string }[] = [];
    if (c.found_at_url) {
      urls.add(c.found_at_url);
      evidence.push({ url: c.found_at_url, title: c.found_at_title ?? "", excerpt: c.found_at_excerpt ?? "" });
    }
    for (const k of checks) {
      if (k.candidate_id !== c.id || k.pass !== 1) continue;
      for (const e of k.evidence) {
        if (urls.has(e.url)) continue;
        urls.add(e.url);
        evidence.push({ url: e.url, title: e.title, excerpt: e.excerpt });
      }
    }
    return { ref: c.id, name: c.name, city: c.city, state: c.state, website: c.website, phone: c.phone, evidence: evidence.slice(0, 12) };
  });
  const { data, droppedUrls, web } = await secondPass(aiContext(deps, run, true), { today: now().toISOString().slice(0, 10), companies }, run.rigor);
  const byRef = new Map(data.map((v) => [v.ref, v]));
  const seen: SeenItem[] = [];
  for (const c of batch) {
    const v = byRef.get(c.id);
    for (const k of v?.checks ?? []) {
      await deps.store.addCheck({ candidateId: c.id, kind: k.kind, pass: 2, result: k.result, summary: k.summary, evidence: k.evidence });
    }
    const verdict = v?.verdict ?? "unsure";
    const patch: CandidatePatch = { second_pass: verdict };
    // Finding 11: a refuted company is cold and loses its call opener (it only shows in "Todos").
    if (verdict === "refuted") {
      patch.temperature = "cold";
      patch.hook = null;
    }
    await deps.store.updateCandidate(c.id, patch);
    if (verdict !== "stands") {
      const no = v?.checks.find((k) => k.result === "no");
      seen.push({
        name: c.name,
        verdict: verdict === "refuted" ? "drop" : "unknown",
        line: no?.summary ?? NOT_RETURNED,
        source: no?.evidence[0]?.title ?? "",
      });
    }
  }
  await patchProgress(deps, run, {
    errorStreak: 0,
    seen: [...seen, ...(run.progress.seen ?? [])].slice(0, SEEN_KEEP),
    droppedUrls: dropped(run, droppedUrls),
    budgetHits: budgetHits(run, "second_pass", web),
    trimmedCalls: trimmedCalls(run, web),
  });
}

// ---------------------------------------------------------------- finalize, counts
export function computeCounts(candidates: CandidateRow[], checks: CheckWithEvidence[], sources: number): StageCounts {
  const ok = (kind: CheckKind) =>
    new Set(checks.filter((k) => k.pass === 1 && k.kind === kind && k.result === "ok").map((k) => k.candidate_id)).size;
  return {
    sources,
    candidates: candidates.length,
    verified: candidates.filter((c) => c.verified_at).length,
    existsOk: ok("exists_active"),
    hasWorkOk: ok("has_work"),
    fitsOk: ok("fits_profile"),
    secondPassDone: candidates.filter((c) => c.second_pass).length,
    refuted: candidates.filter((c) => c.second_pass === "refuted").length,
  };
}

async function refreshCounts(deps: EngineDeps, run: RunRow) {
  const [candidates, checks, sources] = await Promise.all([
    deps.store.listCandidates(run.id),
    deps.store.listChecks(run.id),
    deps.store.listSources(run.id),
  ]);
  await deps.store.updateRun(run.id, { progress: { ...run.progress, counts: computeCounts(candidates, checks, sources.length) } });
}

const CAP_TOO_LOW = "O teto de custo ficou baixo demais para buscar (sobra pouco depois das perguntas e do plano); aumente o teto da pesquisa.";

const PARTIAL_REASON = {
  cost: "O teto de custo da pesquisa foi atingido; a lista traz o que já tinha sido checado.",
  time: "O tempo máximo da pesquisa acabou; a lista traz o que já tinha sido checado.",
} as const;

/** P10 + G8: the "limits of this research" notes come from the sources' statuses (including empty ones). */
export function limitsFromSources(sources: { title: string; status: string; note: string }[]): LimitNote[] {
  const notes: LimitNote[] = [];
  for (const s of sources) {
    if (s.status === "blocked") notes.push({ kind: "blocked", text: `${s.title}: ${s.note || "bloqueou a leitura automática."}` });
    else if (s.status === "error") notes.push({ kind: "error", text: `${s.title}: ${s.note || "não carregou."}` });
    else if (s.status === "empty") notes.push({ kind: "empty", text: `${s.title}: ${s.note || "sem resultado para esta região."}` });
    else if (s.status === "unverified") notes.push({ kind: "unverified", text: `${s.title}: achada na busca, não aberta.${s.note ? ` ${s.note}` : ""}` });
  }
  const order = { blocked: 0, error: 1, empty: 2, unverified: 3, merged: 4, partial: 5, estimate: 6, budget: 7 } as const;
  return notes.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * Plain notes on the app's own limits that shaped this run: the per-call web budget (max_uses, set by the app to
 * hold the cost, never "the search tool's limit") and why the collection stopped early.
 */
export function limitsFromProgress(p: Progress, rigor: Rigor = "careful"): LimitNote[] {
  const notes: LimitNote[] = [];
  const hits = p.budgetHits ?? {};
  const WEB_LIMITS = WEB_LIMITS_BY_RIGOR[rigor];
  const per = (w: { search: { maxUses: number }; fetch: { maxUses: number } }) => `${w.search.maxUses} buscas e ${w.fetch.maxUses} leituras de página`;
  const app = "um limite do próprio app para segurar o custo";
  if (hits.discover_sources) {
    notes.push({ kind: "budget", text: `Descobrir fontes: a IA usou tudo o que o app libera nesta etapa (${per(WEB_LIMITS.discover)}, ${app}). Fontes sem página confirmada ficaram como "achada, não aberta".` });
  }
  if (hits.collect) {
    notes.push({ kind: "budget", text: `Juntar empresas: em ${hits.collect} de ${p.collectRounds ?? hits.collect} rodada(s) a IA usou tudo o que o app libera por rodada (${per(WEB_LIMITS.collect)}, ${app}). O que ela achou até ali foi guardado.` });
  }
  if (hits.verify) {
    notes.push({ kind: "budget", text: `Checar: em ${hits.verify} lote(s) a IA usou tudo o que o app libera por lote (${per(WEB_LIMITS.verify)}, ${app}). Checagem sem prova ficou "?".` });
  }
  if (hits.second_pass) {
    notes.push({ kind: "budget", text: `Segunda passada: em ${hits.second_pass} lote(s) a IA usou tudo o que o app libera por lote (${app}).` });
  }
  if (p.trimmedCalls) {
    notes.push({ kind: "budget", text: `Em ${p.trimmedCalls} chamada(s) a IA recebeu menos buscas que o normal, para caber no que restava do teto de custo da pesquisa.` });
  }
  if (p.alreadyKnown) {
    notes.push({ kind: "merged", text: `${p.alreadyKnown} empresa(s) já estavam em LEADS e foram puladas: este agente só traz empresas novas.` });
  }
  if (p.collectStop === "empty") {
    notes.push({ kind: "estimate", text: `Juntar empresas: ${MAX_EMPTY_ROUNDS} rodadas seguidas, com buscas diferentes, não acharam empresa nova; a coleta parou.` });
  } else if (p.collectStop === "cost") {
    notes.push({ kind: "estimate", text: "Juntar empresas: a coleta parou antes para sobrar custo para checar as empresas já achadas." });
  }
  return notes;
}

async function finalize(deps: EngineDeps, stale: RunRow, now: () => Date, partial: "cost" | "time" | null) {
  // Finding 6: re-read first; a Cancel or Pause that landed during the step wins (no illegal transition).
  const run = await reload(deps, stale.id);
  if (run.status !== "running" && run.status !== "paused") return;
  const [candidates, checks, sources] = await Promise.all([
    deps.store.listCandidates(run.id),
    deps.store.listChecks(run.id),
    deps.store.listSources(run.id),
  ]);
  const notes = limitsFromSources(sources);
  // The cap ran out before any search (discover could not run even at its smallest): say so plainly.
  const tooLow = partial === "cost" && (run.progress.stage ?? "discover_sources") === "discover_sources" && candidates.length === 0;
  const reason = partial ? (tooLow ? CAP_TOO_LOW : PARTIAL_REASON[partial]) : null;
  if (partial) {
    notes.unshift({ kind: "partial", text: reason! });
    for (const c of candidates) {
      if (!c.verified_at) await deps.store.updateCandidate(c.id, { is_partial: true });
    }
  }
  const capped = candidates.length >= run.max_candidates;
  if (capped) notes.push({ kind: "estimate", text: `A busca parou em ${run.max_candidates} empresas, o limite do plano.` });
  if (run.progress.merged?.length) {
    notes.push({ kind: "merged", text: `Unificadas como a mesma empresa: ${run.progress.merged.join("; ")}.` });
  }
  if (run.progress.droppedUrls) {
    notes.push({ kind: "estimate", text: `${run.progress.droppedUrls} link(s) citados pela IA foram descartados porque nenhuma busca os devolveu.` });
  }
  notes.push(...limitsFromProgress(run.progress, run.rigor));
  await deps.store.updateRun(run.id, {
    status: "done",
    is_partial: Boolean(partial),
    partial_reason: reason,
    limits_notes: notes,
    progress: { ...run.progress, stage: "finalize", counts: computeCounts(candidates, checks, sources.length), errorStreak: 0 },
  });
}

async function patchProgress(deps: EngineDeps, run: RunRow, patch: Partial<Progress>) {
  const p: RunPatch = { progress: { ...run.progress, ...patch } };
  await deps.store.updateRun(run.id, p);
}
