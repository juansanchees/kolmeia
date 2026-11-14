// Shared research vocabulary (safe for client and server).

export const RIGORS = ["quick", "careful", "strict"] as const;
export type Rigor = (typeof RIGORS)[number];

export const RUN_STATUSES = ["questions", "plan", "ready", "running", "paused", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STAGES = ["discover_sources", "collect", "verify", "second_pass", "finalize"] as const;
export type Stage = (typeof STAGES)[number];

export const CHECK_KINDS = ["exists_active", "has_work", "fits_profile", "decision_maker"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CHECK_RESULTS = ["ok", "no", "unknown"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const TEMPERATURES = ["very_hot", "hot", "warm", "cold"] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export const APPROACHES = ["call", "supplier_signup", "email"] as const;
export type Approach = (typeof APPROACHES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EMAIL_TYPES = ["named", "generic", "personal", "none"] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

export const COMPANY_TYPES = ["builder", "developer", "property_manager", "other"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const SOURCE_KINDS = [
  "permits",
  "business_registry",
  "license_lookup",
  "association",
  "awards",
  "news",
  "bids",
  "maps_reviews",
  "company_site",
  "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * used = opened and useful; empty = opened, nothing for this region; unverified = found by a search, not opened;
 * blocked = an actual refusal (robots, 403, login wall); error = did not load.
 */
export const SOURCE_STATUSES = ["used", "empty", "unverified", "blocked", "error"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** How a company entered the run: a directory/registry/association listing, a search result, or a job/permit signal. */
export const ENTRY_PATHS = ["directory", "search", "signal"] as const;
export type EntryPath = (typeof ENTRY_PATHS)[number];

export const DECISIONS = ["pending", "keep", "drop"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Which checks each rigor runs (docs/mvp-harness.md 12.3). */
export const CHECKS_BY_RIGOR: Record<Rigor, readonly CheckKind[]> = {
  quick: ["exists_active"],
  careful: ["exists_active", "has_work"],
  strict: ["exists_active", "has_work", "fits_profile", "decision_maker"],
};

export const SECOND_PASS_BY_RIGOR: Record<Rigor, boolean> = { quick: false, careful: false, strict: true };

/** Default caps per rigor. The user may change them before approving, up to the hard ceilings. */
// Raised on 10/11/2026 with finding 2: every call reserves its worst case. Since 14/11/2026 (modo econômico) a call
// that does not fit the run's remaining budget asks for fewer searches instead of stopping (ai/routing.ts), so a
// Rápida run also works with a US$ 1 cap.
export const DEFAULT_CAPS: Record<Rigor, { maxCandidates: number; maxCostUsd: number; maxMinutes: number }> = {
  quick: { maxCandidates: 15, maxCostUsd: 2, maxMinutes: 20 },
  careful: { maxCandidates: 20, maxCostUsd: 3, maxMinutes: 40 },
  strict: { maxCandidates: 25, maxCostUsd: 5, maxMinutes: 60 },
};

export const HARD_CEILING = { maxCandidates: 60, maxCostUsd: 10, maxMinutes: 180 } as const;

export type Question = { id: string; text: string; options: string[]; allowFreeText: boolean };
export type Answers = Record<string, { choices: string[]; text: string }>;

export type Plan = {
  summary: string;
  places: string[];
  sourceTypes: string[];
  warnings: string[];
};

export type StageCounts = {
  sources: number;
  candidates: number;
  verified: number;
  existsOk: number;
  hasWorkOk: number;
  fitsOk: number;
  secondPassDone: number;
  refuted: number;
};

export type SeenItem = { name: string; verdict: "keep" | "unknown" | "drop"; line: string; source: string };

export type Progress = {
  understood?: string;
  places?: string[];
  stage?: Stage;
  errorStreak?: number;
  collectRounds?: number;
  counts?: StageCounts;
  seen?: SeenItem[];
  pauseReason?: "user" | "daily_cap" | "user_cap" | "global_cap" | "no_access";
  lastError?: string;
  /** G9: names unified as duplicates ("Acme Builders (= Acme Builders, Inc.)"), shown in the run's notes. */
  merged?: string[];
  /** Cited URLs dropped because no web tool returned them (finding 3), summed over the run. */
  droppedUrls?: number;
  /** Collect rounds in a row that added no new company (the collection stops after MAX_EMPTY_ROUNDS). */
  emptyRounds?: number;
  /** Searches already run by the collect rounds (the next round is told not to repeat them). */
  queries?: string[];
  /** Calls per stage that used their whole per-call web budget (max_uses); shown, in plain words, in the limits. */
  budgetHits?: Partial<Record<"discover_sources" | "collect" | "verify" | "second_pass", number>>;
  /** Why the collection stopped, when it was not the normal end (shown in the limits). */
  collectStop?: "empty" | "cost";
  /** Calls whose web budget was shrunk to fit the run's remaining cost cap (shown in the limits). */
  trimmedCalls?: number;
  /** F3b: companies the collection found that were already in LEADS and were skipped (agent runs only). */
  alreadyKnown?: number;
};

export type LimitNote = {
  kind: "blocked" | "error" | "empty" | "unverified" | "merged" | "partial" | "estimate" | "budget";
  text: string;
};
