// Row shapes as stored in Postgres (migration 0002). Shared by the engine, the stores and the screens.
import type {
  Answers,
  Approach,
  CheckKind,
  CheckResult,
  CompanyType,
  Confidence,
  Decision,
  EmailType,
  EntryPath,
  LimitNote,
  Plan,
  Progress,
  Question,
  Rigor,
  RunStatus,
  SourceKind,
  SourceStatus,
  Temperature,
} from "./types";

export type RunRow = {
  id: string;
  workspace_id: string;
  title: string;
  request_text: string;
  region_text: string;
  rigor: Rigor;
  status: RunStatus;
  questions: Question[] | null;
  answers: Answers;
  adjustments: string[];
  plan: Plan | null;
  max_candidates: number;
  max_cost_usd: number;
  max_minutes: number;
  spent_cost_usd: number;
  progress: Progress;
  is_partial: boolean;
  partial_reason: string | null;
  limits_notes: LimitNote[];
  error: string | null;
  approved_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  /** F2: the Caçador this run is the setup chat of; null for a one-off search. */
  setup_agent_id?: string | null;
  /** F3b: the Caçador this run belongs to (an agent run, driven by the background tick); null for a one-off search. */
  agent_id?: string | null;
};

export const RUN_COLUMNS =
  "id, workspace_id, title, request_text, region_text, rigor, status, questions, answers, adjustments, plan, max_candidates, max_cost_usd, max_minutes, spent_cost_usd, progress, is_partial, partial_reason, limits_notes, error, approved_at, started_at, finished_at, created_at, setup_agent_id, agent_id";

/** Fields the engine (or a user action) may change on a run. */
export type RunPatch = Partial<
  Pick<
    RunRow,
    | "status"
    | "questions"
    | "answers"
    | "adjustments"
    | "plan"
    | "rigor"
    | "region_text"
    | "max_candidates"
    | "max_cost_usd"
    | "max_minutes"
    | "progress"
    | "is_partial"
    | "partial_reason"
    | "limits_notes"
    | "error"
    | "finished_at"
  >
>;

export type SourceRow = {
  id: string;
  run_id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  status: SourceStatus;
  note: string;
};

export type SourceInsert = Omit<SourceRow, "id">;

export type CandidateRow = {
  id: string;
  run_id: string;
  name: string;
  name_key: string;
  city: string | null;
  state: string | null;
  region: string | null;
  website: string | null;
  phone: string | null;
  public_email: string | null;
  email_type: EmailType | null;
  company_type: CompanyType;
  size_note: string | null;
  temperature: Temperature | null;
  approach: Approach | null;
  ask_for_name: string | null;
  ask_for_title: string | null;
  name_confidence: Confidence | null;
  name_source_url: string | null;
  name_note: string | null;
  permit_count: number | null;
  total_value_usd: number | null;
  last_permit_date: string | null;
  biggest_job_address: string | null;
  biggest_job_value_usd: number | null;
  biggest_job_type: string | null;
  biggest_job_description: string | null;
  signal_match: string | null;
  google_rating: number | null;
  review_count: number | null;
  hook: string | null;
  supplier_portal_url: string | null;
  notes: string | null;
  user_decision: Decision;
  second_pass: "stands" | "refuted" | "unsure" | null;
  is_partial: boolean;
  verified_at: string | null;
  /** How it entered the run (G1 "Empresas novas" = signal). Null on rows from before 0004. */
  entry_path: EntryPath | null;
  /** The page where collect found it (returned by a web tool), shown as proof. */
  found_at_url: string | null;
  found_at_title: string | null;
  found_at_excerpt: string | null;
  found_at_seen_at: string | null;
  /** Finding 5: the page that shows each contact field; null = shown as unverified ("?"). */
  phone_source_url: string | null;
  email_source_url: string | null;
  rating_source_url: string | null;
};

export const CANDIDATE_COLUMNS =
  "id, run_id, name, name_key, city, state, region, website, phone, public_email, email_type, company_type, size_note, temperature, approach, ask_for_name, ask_for_title, name_confidence, name_source_url, name_note, permit_count, total_value_usd, last_permit_date, biggest_job_address, biggest_job_value_usd, biggest_job_type, biggest_job_description, signal_match, google_rating, review_count, hook, supplier_portal_url, notes, user_decision, second_pass, is_partial, verified_at, entry_path, found_at_url, found_at_title, found_at_excerpt, found_at_seen_at, phone_source_url, email_source_url, rating_source_url";

export type CandidateInsert = Pick<
  CandidateRow,
  | "name"
  | "name_key"
  | "city"
  | "state"
  | "region"
  | "website"
  | "phone"
  | "company_type"
  | "size_note"
  | "notes"
  | "entry_path"
  | "found_at_url"
  | "found_at_title"
  | "found_at_excerpt"
  | "found_at_seen_at"
  | "phone_source_url"
>;

export type CandidatePatch = Partial<
  Omit<
    CandidateRow,
    "id" | "run_id" | "name" | "name_key" | "entry_path" | "found_at_url" | "found_at_title" | "found_at_excerpt" | "found_at_seen_at"
  >
>;

/** G10 "Obras sem construtora": a job/permit/project whose builder the sources did not name. */
export type JobRow = {
  id: string;
  run_id: string;
  address: string | null;
  project_name: string | null;
  job_type: string | null;
  declared_value_usd: number | null;
  job_date: string | null;
  source_url: string;
  excerpt: string;
  seen_at: string;
};

export const JOB_COLUMNS = "id, run_id, address, project_name, job_type, declared_value_usd, job_date, source_url, excerpt, seen_at";

export type JobInsert = Omit<JobRow, "id" | "run_id" | "seen_at"> & { seen_at: string | null };

export function normalizeJob(r: Record<string, unknown>): JobRow {
  const d = r.job_date;
  const seen = r.seen_at;
  return {
    ...(r as unknown as JobRow),
    declared_value_usd: num(r.declared_value_usd),
    job_date: d instanceof Date ? d.toISOString().slice(0, 10) : (d as string | null),
    seen_at: seen instanceof Date ? seen.toISOString() : (seen as string),
  };
}

export type CheckRow = {
  id: string;
  candidate_id: string;
  kind: CheckKind;
  pass: 1 | 2;
  result: CheckResult;
  summary: string;
};

export type EvidenceRow = {
  id: string;
  check_id: string;
  url: string;
  title: string;
  excerpt: string;
  seen_at: string;
};

export type CheckInsert = {
  candidateId: string;
  kind: CheckKind;
  pass: 1 | 2;
  result: CheckResult;
  summary: string;
  evidence: { url: string; title: string; excerpt: string; seenAt?: string }[];
};

/** Postgres numeric comes back as a string from both PostgREST and PGlite. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeRun(r: Record<string, unknown>): RunRow {
  return {
    ...(r as unknown as RunRow),
    max_cost_usd: num(r.max_cost_usd) ?? 0,
    spent_cost_usd: num(r.spent_cost_usd) ?? 0,
    answers: (r.answers as Answers) ?? {},
    adjustments: (r.adjustments as string[]) ?? [],
    progress: (r.progress as Progress) ?? {},
    limits_notes: (r.limits_notes as LimitNote[]) ?? [],
  };
}

export function normalizeCandidate(r: Record<string, unknown>): CandidateRow {
  const date = r.last_permit_date;
  const foundSeen = r.found_at_seen_at;
  return {
    ...(r as unknown as CandidateRow),
    found_at_seen_at: foundSeen instanceof Date ? foundSeen.toISOString() : ((foundSeen as string | null) ?? null),
    total_value_usd: num(r.total_value_usd),
    biggest_job_value_usd: num(r.biggest_job_value_usd),
    google_rating: num(r.google_rating),
    last_permit_date: date instanceof Date ? date.toISOString().slice(0, 10) : (date as string | null),
  };
}
