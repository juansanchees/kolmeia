export const QUALIFIER_STEPS = ["p1", "p2", "p2b", "p3", "p4", "p5"] as const;
export type QualifierStep = (typeof QUALIFIER_STEPS)[number];

export type StepOutcome =
  | "ok"
  | "skipped"
  | "no_site"
  | "site_blocked"
  | "site_down"
  | "robots"
  | "not_html"
  | "places_off"
  | "closed"
  | "no_ai"
  | "queued"
  | "no_source"
  | "error"
  | "lead_cap"
  | "day_cap"
  | "deadline";

export type DoneReason = "complete" | "lead_cap" | "dead";
export type QualifierPauseReason = "daily_cap" | "workspace_cap" | "user_cap" | "global_cap" | "no_access";
export type QualifierCounts = { leads: number; steps: number; paused: number; failed: number };

/** One value of a lead as the claim returns it (lead_fields). */
export type FieldRow = {
  id: string;
  leadId: string;
  field: string;
  value: string;
  source: string;
  sourceRef: string | null;
  status: "unverified" | "confirmed" | "refuted";
  excerpt: string | null;
  seenAt: string | null;
};

/** One value to write: the exact keys qualifier_add_fields accepts. */
export type FieldIn = {
  field: string;
  value: string;
  key?: string | null;
  source: "site" | "places" | "ai";
  source_ref?: string | null;
  status?: "confirmed" | "unverified";
  excerpt?: string | null;
  seen_at?: string | null;
};

export type LeadSnapshot = {
  leadId: string;
  workspaceId: string;
  nextStep: QualifierStep;
  level: number;
  spentUsd: number;
  failStep: QualifierStep | null;
  failStreak: number;
  deepRequested: boolean;
  manual: boolean;
  profileMatch: boolean;
  notes: Record<string, string>;
  fields: FieldRow[];
  best: { name: string | null; website: string | null; phone: string | null; city: string | null; state: string | null } | null;
  settings: { dailyCapUsd: number; leadCapUsd: number; autoDeep: boolean; spentToday: number };
  companyProfile: unknown;
};

export type PlaceHit = {
  placeId: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  status: "OPERATIONAL" | "CLOSED_TEMPORARILY" | "CLOSED_PERMANENTLY" | null;
};

export interface PlacesClient {
  search(q: { name: string; city: string | null; state: string | null }): Promise<PlaceHit | null>;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const STEP = new Set<string>(QUALIFIER_STEPS);
const stepOr = (v: unknown, d: QualifierStep): QualifierStep => (typeof v === "string" && STEP.has(v) ? (v as QualifierStep) : d);
const STATUS = new Set(["unverified", "confirmed", "refuted"]);

/** The claim's JSON (snake_case, from the database) as a typed snapshot. Anything malformed falls back to a safe value. */
export function normalizeSnapshot(raw: unknown): LeadSnapshot {
  const r = rec(raw);
  const s = rec(r.settings);
  const best = r.best && typeof r.best === "object" ? rec(r.best) : null;
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(r.notes))) if (typeof v === "string") notes[k] = v;
  const fields: FieldRow[] = (Array.isArray(r.fields) ? r.fields : []).flatMap((x): FieldRow[] => {
    const f = rec(x);
    const id = str(f.id);
    const field = str(f.field);
    const value = str(f.value);
    if (!id || !field || value === null) return [];
    // an e-mail guess (source 'pattern', 0028) is not a fact: the cascade never sees it
    if (f.source === "pattern") return [];
    return [
      {
        id,
        leadId: str(f.lead_id) ?? str(r.lead_id) ?? "",
        field,
        value,
        source: str(f.source) ?? "import",
        sourceRef: str(f.source_ref),
        status: STATUS.has(String(f.status)) ? (f.status as FieldRow["status"]) : "unverified",
        excerpt: str(f.excerpt),
        seenAt: str(f.seen_at),
      },
    ];
  });
  return {
    leadId: str(r.lead_id) ?? "",
    workspaceId: str(r.workspace_id) ?? "",
    nextStep: stepOr(r.next_step, "p1"),
    level: num(r.level),
    spentUsd: num(r.spent_usd),
    failStep: r.fail_step ? stepOr(r.fail_step, "p1") : null,
    failStreak: num(r.fail_streak),
    deepRequested: r.deep_requested === true,
    manual: r.manual === true,
    profileMatch: r.profile_match === true,
    notes,
    fields,
    best: best ? { name: str(best.name), website: str(best.website), phone: str(best.phone), city: str(best.city), state: str(best.state) } : null,
    settings: { dailyCapUsd: num(s.daily_cap_usd, 5), leadCapUsd: num(s.lead_cap_usd, 0.5), autoDeep: s.auto_deep !== false, spentToday: num(s.spent_today) },
    companyProfile: r.company_profile ?? null,
  };
}
