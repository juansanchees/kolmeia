import "server-only";
import { hostOf, rootOf, sanitizeUrl } from "@/lib/safe-url";
import { applyEvidenceRules, clip, normalizeHook, type CheckIn, type SeenFilter } from "@/lib/research/rules";
import type { CheckKind, CompanyType, Confidence, EmailType, EntryPath, Plan, Question, Rigor, SourceKind, SourceStatus } from "@/lib/research/types";
import { reserveFor, runTask, type AiContext, type TaskDef, type TaskMeta, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import * as collectP from "./prompts/collect";
import * as discoverP from "./prompts/discover";
import * as planP from "./prompts/plan";
import * as questionsP from "./prompts/questions";
import * as secondP from "./prompts/second-pass";
import { budgetLine } from "./prompts/shared";
import * as verifyP from "./prompts/verify";
import {
  collectSchema,
  discoverSchema,
  planSchema,
  questionsSchema,
  secondPassSchema,
  verifySchemaFor,
  type CollectOut,
  type DiscoverOut,
  type JobOut,
  type PlanOut,
  type QuestionsOut,
  type SecondPassOut,
  type VerifyOut,
} from "./schemas";

// One typed function per AI task. Each: stable prompt + PROMPT_VERSION, zod schema, normalize (caps, URL checks).
// Only fields that survive normalize are ever stored (R15). Every URL kept must have been returned by a web tool in
// that call (finding 3); the gateway reserves each task's worst case computed from the limits below (finding 2).

/**
 * Web limits per call (max_uses). Raised on 10/11/2026 after the "0 companies" run: with 3 searches a collect call
 * ran out before it could list anyone (docs/mvp/fase-1-3-pesquisa.md, "0 empresas"). The model is told the budget
 * in the request; reaching it is a normal end of searching, reported in the run's limits.
 */
export const WEB_LIMITS = {
  discover: { search: { maxUses: 6 }, fetch: { maxUses: 3 } },
  collect: { search: { maxUses: 8 }, fetch: { maxUses: 6 } },
  verify: { search: { maxUses: 3 }, fetch: { maxUses: 6 } },
  second: { search: { maxUses: 2 }, fetch: { maxUses: 4 } },
} as const;

/** The request text plus this call's web budget (so the model can plan its searches). */
const withBudget =
  <I>(build: (i: I) => string, web: { search?: { maxUses: number }; fetch?: { maxUses: number } }) =>
  (i: I) =>
    `${build(i)}\n${budgetLine(web)}`;

// ---------------------------------------------------------------- small normalizers
const list = (xs: string[], max: number, len: number) => xs.map((x) => clip(x, len)).filter(Boolean).slice(0, max);

export function cleanPhone(raw: string): string | null {
  const s = raw.replace(/[^0-9+().\-\sx]/gi, "").replace(/\s+/g, " ").trim();
  return s.replace(/\D/g, "").length >= 7 ? s.slice(0, 40) : null;
}

export function cleanEmail(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** "US$ 1,824,500" / "1.8M" -> number; anything unclear -> null (P2: never a guessed value). */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/us\$|\$|usd|,|\s/g, "");
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : null;
}

export function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  return /^\d{1,7}$/.test(s) ? Number(s) : null;
}

export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

export function parseRating(raw: string): number | null {
  const n = Number(raw.trim().replace(",", "."));
  return raw.trim() && Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n * 10) / 10 : null;
}

const slug = (s: string, i: number) => clip(s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""), 40) || `q${i + 1}`;
const orNull = (s: string, max: number) => clip(s, max) || null;

/** A URL the model cited, kept only when it is safe AND a web tool returned it in this call. */
export function seenUrl(raw: string, meta: TaskMeta): string | null {
  const url = sanitizeUrl(raw);
  if (!url) return null;
  if (!meta.seen(url)) {
    meta.dropped.count++;
    return null;
  }
  return url;
}

const filterOf = (meta: TaskMeta): SeenFilter => ({ seen: (u) => meta.seen(u), seenAt: (u) => meta.seenAt(u), dropped: meta.dropped });

// ---------------------------------------------------------------- 1. questions (Opus)
export type QuestionsResult = { understood: string; places: string[]; questions: Question[] };

const questionsDef: TaskDef<questionsP.QuestionsInput, QuestionsOut, QuestionsResult> = {
  task: "research_questions",
  model: MODELS.opus,
  promptVersion: questionsP.PROMPT_VERSION,
  system: questionsP.SYSTEM,
  schema: questionsSchema,
  effort: "medium",
  maxTokens: 16_000,
  buildUser: questionsP.buildUser,
  normalize: (p) => {
    const ids = new Set<string>();
    const questions: Question[] = [];
    for (const [i, q] of p.questions.entries()) {
      const options = list(q.options, 4, 80);
      const text = clip(q.text, 200);
      if (!text || options.length < 2) continue;
      let id = slug(q.id, i);
      while (ids.has(id)) id = `${id}_${i}`;
      ids.add(id);
      questions.push({ id, text, options, allowFreeText: q.allow_free_text });
      if (questions.length === 5) break;
    }
    return { understood: clip(p.understood, 300), places: list(p.places, 12, 120), questions };
  },
};

export function askQuestions(ctx: AiContext, input: questionsP.QuestionsInput): Promise<TaskResult<QuestionsResult>> {
  return runTask(ctx, questionsDef, input);
}

// ---------------------------------------------------------------- 2. plan (Opus)
const planDef: TaskDef<planP.PlanInput, PlanOut, Plan> = {
  task: "research_plan",
  model: MODELS.opus,
  promptVersion: planP.PROMPT_VERSION,
  system: planP.SYSTEM,
  schema: planSchema,
  effort: "high",
  maxTokens: 16_000,
  buildUser: planP.buildUser,
  normalize: (p) => ({
    summary: clip(p.summary, 400),
    places: list(p.places, 20, 120),
    sourceTypes: list(p.source_types, 10, 160),
    warnings: list(p.warnings, 6, 240),
  }),
};

export function writePlan(ctx: AiContext, input: planP.PlanInput): Promise<TaskResult<Plan>> {
  return runTask(ctx, planDef, input);
}

// ---------------------------------------------------------------- 3. discover sources (Sonnet + web)
export type FoundSource = { kind: SourceKind; title: string; url: string | null; status: SourceStatus; note: string };

/**
 * Sources: unsafe URLs are dropped (R11). A URL no web tool returned is never stored (finding 3), but the source
 * itself is kept without its link (status "unverified") and counted as a dropped URL; the root page of a site the
 * tools did return pages from is accepted. With the tool results at hand (meta), the status is made honest
 * (finding 17): "blocked" needs a fetch that was actually attempted; "used"/"empty" need a page that was actually
 * opened; otherwise the source is "unverified" (found, not opened). `requireUrl` drops sources left without a link
 * (collect's sources_tried, where a link-less entry is the model narrating, not a source).
 */
export function normalizeSources(raw: DiscoverOut["sources"], max = 20, meta?: TaskMeta, requireUrl = false): FoundSource[] {
  const out: FoundSource[] = [];
  for (const s of raw) {
    let url = s.url.trim() ? sanitizeUrl(s.url) : null;
    if (s.url.trim() && !url) continue; // unsafe or blocked host (R11): dropped, never stored
    let status: SourceStatus = s.status;
    if (url && meta && !meta.seen(url) && !meta.tried(url)) {
      const root = rootOf(url);
      if (!(root && meta.seenHost?.(url))) {
        meta.dropped.count++;
        url = null;
        status = "unverified";
      }
    }
    if (requireUrl && !url) continue;
    const title = clip(s.title, 200);
    if (!title) continue;
    if (meta && url) {
      if (status === "blocked" && !meta.tried(url)) status = "unverified";
      else if ((status === "used" || status === "empty") && !meta.fetched(url)) status = "unverified";
    }
    out.push({ kind: s.kind, title, url, status, note: clip(s.note, 500) });
    if (out.length >= max) break;
  }
  return out;
}

const discoverDef: TaskDef<discoverP.DiscoverInput, DiscoverOut, FoundSource[]> = {
  task: "research_discover",
  model: MODELS.sonnet,
  promptVersion: discoverP.PROMPT_VERSION,
  system: discoverP.SYSTEM,
  schema: discoverSchema,
  effort: "medium",
  maxTokens: 12_000,
  web: WEB_LIMITS.discover,
  buildUser: withBudget(discoverP.buildUser, WEB_LIMITS.discover),
  normalize: (p, _i, meta) => normalizeSources(p.sources, 20, meta),
};

export function discoverSources(ctx: AiContext, input: discoverP.DiscoverInput): Promise<TaskResult<FoundSource[]>> {
  return runTask(ctx, discoverDef, input);
}

// ---------------------------------------------------------------- jobs without a builder (G10)
export type FoundJob = {
  address: string | null;
  projectName: string | null;
  jobType: string | null;
  declaredValueUsd: number | null;
  jobDate: string | null;
  sourceUrl: string;
  excerpt: string;
  seenAt: string | null;
};

/** Only jobs whose page a web tool returned, with an address or a project name; nothing is invented. */
export function normalizeJobs(raw: JobOut[], meta: TaskMeta, max = 20): FoundJob[] {
  const out: FoundJob[] = [];
  const keys = new Set<string>();
  for (const j of raw) {
    const url = seenUrl(j.url, meta);
    const address = orNull(j.address, 200);
    const projectName = orNull(j.project_name, 200);
    if (!url || (!address && !projectName)) continue;
    const k = `${url}|${(address ?? projectName ?? "").toLowerCase()}`;
    if (keys.has(k)) continue;
    keys.add(k);
    out.push({
      address,
      projectName,
      jobType: orNull(j.job_type, 100),
      declaredValueUsd: parseAmount(j.declared_value_usd),
      jobDate: parseDate(j.date),
      sourceUrl: url,
      excerpt: clip(j.excerpt, 300),
      seenAt: meta.seenAt(url) ?? null,
    });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------- 4. collect candidates (Sonnet + web)
export type CollectedCandidate = {
  name: string;
  city: string | null;
  state: string | null;
  region: string | null;
  website: string | null;
  phone: string | null;
  phoneSourceUrl: string | null;
  companyType: CompanyType;
  sizeNote: string | null;
  entryPath: EntryPath;
  foundAt: { url: string; title: string; excerpt: string; seenAt?: string } | null;
};
export type CollectResult = { candidates: CollectedCandidate[]; sourcesTried: FoundSource[]; jobs: FoundJob[]; exhausted: boolean };

const collectDef: TaskDef<collectP.CollectInput, CollectOut, CollectResult> = {
  task: "research_collect",
  model: MODELS.sonnet,
  promptVersion: collectP.PROMPT_VERSION,
  system: collectP.SYSTEM,
  schema: collectSchema,
  effort: "medium",
  maxTokens: 16_000,
  web: WEB_LIMITS.collect,
  buildUser: withBudget(collectP.buildUser, WEB_LIMITS.collect),
  normalize: (p, input, meta) => {
    const candidates: CollectedCandidate[] = [];
    for (const c of p.candidates) {
      const name = clip(c.name, 200);
      if (!name) continue;
      const foundUrl = seenUrl(c.found_at.url, meta);
      const phone = cleanPhone(c.phone);
      candidates.push({
        name,
        city: orNull(c.city, 100),
        state: orNull(c.state, 40),
        region: orNull(c.region, 100),
        website: sanitizeUrl(c.website),
        phone,
        phoneSourceUrl: phone ? seenUrl(c.phone_source_url, meta) : null,
        companyType: c.company_type,
        sizeNote: orNull(c.size_note, 300),
        // A company only counts as "entered through a signal" when the signal page itself was returned.
        entryPath: c.entry_path === "signal" && !foundUrl ? "search" : c.entry_path,
        foundAt: foundUrl
          ? { url: foundUrl, title: clip(c.found_at.title, 200), excerpt: clip(c.found_at.excerpt, 300), ...(meta.seenAt(foundUrl) ? { seenAt: meta.seenAt(foundUrl) } : {}) }
          : null,
      });
      if (candidates.length >= input.want) break;
    }
    const sourcesTried = normalizeSources(
      p.sources_tried.map((s) => ({ ...s, kind: "other" as const })),
      15,
      meta,
      true,
    );
    return { candidates, sourcesTried, jobs: normalizeJobs(p.jobs_without_builder, meta), exhausted: p.exhausted };
  },
};

export function collectCandidates(ctx: AiContext, input: collectP.CollectInput): Promise<TaskResult<CollectResult>> {
  return runTask(ctx, collectDef, input);
}

// ---------------------------------------------------------------- 5. verify (Sonnet + web)
export type VerifiedCompany = {
  ref: string;
  checks: (CheckIn & { kind: CheckKind })[];
  permitCount: number | null;
  totalValueUsd: number | null;
  lastPermitDate: string | null;
  biggestJobAddress: string | null;
  biggestJobValueUsd: number | null;
  biggestJobType: string | null;
  biggestJobDescription: string | null;
  signalMatch: string | null;
  askForName: string | null;
  askForTitle: string | null;
  nameConfidence: Confidence | null;
  nameSourceUrl: string | null;
  nameNote: string | null;
  phone: string | null;
  phoneSourceUrl: string | null;
  website: string | null;
  publicEmail: string | null;
  emailType: EmailType | null;
  emailSourceUrl: string | null;
  googleRating: number | null;
  reviewCount: number | null;
  ratingSourceUrl: string | null;
  isLargeContractor: boolean;
  supplierPortalUrl: string | null;
  hook: string | null;
  notes: string | null;
  urlsTried: string[];
};

export type VerifyResult = VerifiedCompany[] & { jobs?: FoundJob[] };

export const NOT_CHECKED = "Não verificado nesta passada.";

/** Keeps only the checks this rigor runs (one per kind), fills missing ones with "unknown", applies P1/P9 and the seen-URL filter. */
export function normalizeChecks(
  raw: { kind: CheckKind; result: CheckIn["result"]; summary: string; evidence: CheckIn["evidence"] }[],
  kinds: readonly CheckKind[],
  rigor: Rigor,
  filter?: SeenFilter,
): (CheckIn & { kind: CheckKind })[] {
  return kinds.map((kind) => {
    const found = raw.find((c) => c.kind === kind);
    if (!found) return { kind, result: "unknown" as const, summary: NOT_CHECKED, evidence: [] };
    return { kind, ...applyEvidenceRules(found, rigor, filter) };
  });
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * Finding 5: who to ask for is kept only when its source page passes sanitizeUrl AND was returned by a web tool;
 * in strict rigor the decision_maker check must also be "ok". With a single source host the confidence is at most
 * "low". Returns nulls ("?") otherwise.
 */
export function contactName(
  c: Pick<VerifyOut["companies"][number], "ask_for_name" | "ask_for_title" | "name_confidence" | "name_source_url" | "name_note">,
  checks: (CheckIn & { kind: CheckKind })[],
  rigor: Rigor,
  meta: TaskMeta,
): { name: string | null; title: string | null; confidence: Confidence | null; sourceUrl: string | null; note: string | null } {
  const none = { name: null, title: null, confidence: null, sourceUrl: null, note: null };
  const name = orNull(c.ask_for_name, 120);
  if (!name || c.name_confidence === "none") return none;
  const sourceUrl = seenUrl(c.name_source_url, meta);
  if (!sourceUrl) return none;
  const dm = checks.find((k) => k.kind === "decision_maker");
  if (rigor === "strict" && dm?.result !== "ok") return none;
  const hosts = new Set([hostOf(sourceUrl), ...(dm?.result === "ok" ? dm.evidence.map((e) => hostOf(e.url)) : [])].filter(Boolean));
  const asked = c.name_confidence as Confidence;
  const confidence: Confidence = hosts.size < 2 && CONFIDENCE_RANK[asked] > CONFIDENCE_RANK.low ? "low" : asked;
  return { name, title: orNull(c.ask_for_title, 120), confidence, sourceUrl, note: orNull(c.name_note, 500) };
}

const verifyDef: TaskDef<verifyP.VerifyInput, VerifyOut, VerifyResult> = {
  task: "research_verify",
  model: MODELS.sonnet,
  promptVersion: verifyP.PROMPT_VERSION,
  system: verifyP.SYSTEM,
  schema: (input) => verifySchemaFor(input.companies.map((c) => c.ref)),
  effort: "medium",
  maxTokens: 16_000,
  web: WEB_LIMITS.verify,
  buildUser: withBudget(verifyP.buildUser, WEB_LIMITS.verify),
  normalize: (p, input, meta) => {
    const refs = new Set(input.companies.map((c) => c.ref));
    const done = new Set<string>();
    const out: VerifyResult = [];
    const filter = filterOf(meta);
    for (const c of p.companies) {
      if (!refs.has(c.ref) || done.has(c.ref)) continue; // unknown refs are ignored (R15)
      done.add(c.ref);
      const checks = normalizeChecks(c.checks, input.kinds, input.rigor, filter);
      const hasWork = checks.find((k) => k.kind === "has_work")?.result ?? null;
      const address = orNull(c.biggest_job_address, 200);
      // P2: signal numbers only when the work check is backed by evidence.
      const signal = hasWork === "ok";
      const who = contactName(c, checks, input.rigor, meta);
      const phone = cleanPhone(c.phone);
      const email = cleanEmail(c.public_email);
      const emailSource = email ? seenUrl(c.email_source_url, meta) : null;
      const ratingSource = c.google_rating.trim() || c.review_count.trim() ? seenUrl(c.rating_source_url, meta) : null;
      out.push({
        ref: c.ref,
        checks,
        permitCount: signal ? parseCount(c.permit_count) : null,
        totalValueUsd: signal ? parseAmount(c.total_value_usd) : null,
        lastPermitDate: signal ? parseDate(c.last_permit_date) : null,
        biggestJobAddress: signal ? address : null,
        biggestJobValueUsd: signal ? parseAmount(c.biggest_job_value_usd) : null,
        biggestJobType: signal ? orNull(c.biggest_job_type, 100) : null,
        biggestJobDescription: signal ? orNull(c.biggest_job_description, 500) : null,
        signalMatch: signal ? orNull(c.signal_match, 300) : null,
        askForName: who.name,
        askForTitle: who.title,
        nameConfidence: who.confidence,
        nameSourceUrl: who.sourceUrl,
        nameNote: who.note,
        // A phone without a returned source is kept but shown as unverified ("?" marker); e-mail and ratings
        // without one are dropped (P2).
        phone,
        phoneSourceUrl: phone ? seenUrl(c.phone_source_url, meta) : null,
        website: sanitizeUrl(c.website),
        publicEmail: emailSource ? email : null,
        emailType: emailSource ? (c.email_type === "none" ? null : c.email_type) : "none",
        emailSourceUrl: emailSource,
        googleRating: ratingSource ? parseRating(c.google_rating) : null,
        reviewCount: ratingSource ? parseCount(c.review_count) : null,
        ratingSourceUrl: ratingSource,
        isLargeContractor: c.is_large_contractor,
        supplierPortalUrl: sanitizeUrl(c.supplier_portal_url),
        hook: normalizeHook(c.hook, signal ? address : null, hasWork),
        notes: orNull(c.notes, 1000),
        urlsTried: list(c.urls_tried, 8, 300),
      });
    }
    out.jobs = normalizeJobs(p.jobs_without_builder, meta);
    return out;
  },
};

export function verifyCompanies(ctx: AiContext, input: verifyP.VerifyInput): Promise<TaskResult<VerifyResult>> {
  return runTask(ctx, verifyDef, input);
}

// ---------------------------------------------------------------- 6. second pass (Opus + web), strict only
export type SecondPassCompany = { ref: string; verdict: "stands" | "refuted" | "unsure"; checks: (CheckIn & { kind: CheckKind })[] };

const secondDef: TaskDef<secondP.SecondPassInput, SecondPassOut, SecondPassCompany[]> = {
  task: "research_second_pass",
  model: MODELS.opus,
  promptVersion: secondP.PROMPT_VERSION,
  system: secondP.SYSTEM,
  schema: secondPassSchema,
  effort: "high",
  maxTokens: 16_000,
  web: WEB_LIMITS.second,
  buildUser: withBudget(secondP.buildUser, WEB_LIMITS.second),
  normalize: (p, input, meta) => {
    const refs = new Set(input.companies.map((c) => c.ref));
    const done = new Set<string>();
    const out: SecondPassCompany[] = [];
    const filter = filterOf(meta);
    for (const c of p.companies) {
      if (!refs.has(c.ref) || done.has(c.ref)) continue;
      done.add(c.ref);
      const checks: (CheckIn & { kind: CheckKind })[] = [];
      const kinds = new Set<CheckKind>();
      for (const k of c.checks) {
        if (kinds.has(k.kind)) continue;
        kinds.add(k.kind);
        checks.push({ kind: k.kind, ...applyEvidenceRules(k, "strict", filter) });
      }
      // A "refuted" verdict must be backed by at least one "no" with evidence; otherwise it is only "unsure".
      const backed = checks.some((k) => k.result === "no" && k.evidence.length > 0);
      out.push({ ref: c.ref, verdict: c.verdict === "refuted" && !backed ? "unsure" : c.verdict, checks });
    }
    return out;
  },
};

export function secondPass(ctx: AiContext, input: secondP.SecondPassInput): Promise<TaskResult<SecondPassCompany[]>> {
  return runTask(ctx, secondDef, input);
}

/** For tests and docs: the definitions (limits, models, reserves). */
export const TASK_DEFS = { questionsDef, planDef, discoverDef, collectDef, verifyDef, secondDef };

/** The reservation (worst case) of one call of a research step, for the engine's "does it still fit?" checks. */
export const RESERVE_USD = {
  discover: reserveFor(discoverDef),
  collect: reserveFor(collectDef),
  verify: reserveFor(verifyDef),
  second: reserveFor(secondDef),
} as const;
