// Client-safe rules of the LEADS list: filters, origin label, stale proof, proof count, CSV.
import type { CandidateRow } from "@/lib/research/rows";
import { byTemperature, inTab, SHEET_COLUMNS, toCsv, type Column, type Tab } from "@/lib/research/sheet";
import type { CheckWithEvidence } from "@/lib/research/store";
import type { Temperature } from "@/lib/research/types";
import { z } from "zod";
import { fill, t } from "@/messages/pt";
import type { LeadDisplay, LeadFieldRow, LeadListItem, LeadStatus } from "./types";

export const STALE_PROOF_DAYS = 90;
const DAY_MS = 86_400_000;

/** C4: proof seen more than 90 days before `now` is "prova velha". A missing or unreadable date is not stale. */
export function isStaleProof(seenAt: string | null | undefined, now: Date): boolean {
  if (!seenAt) return false;
  const ms = Date.parse(seenAt);
  if (Number.isNaN(ms)) return false;
  return now.getTime() - ms > STALE_PROOF_DAYS * DAY_MS;
}

/** Checks that passed and carry at least one piece of evidence. */
export function proofCount(checks: Pick<CheckWithEvidence, "result" | "evidence">[]): number {
  return checks.filter((c) => c.result === "ok" && c.evidence.length > 0).length;
}

export type LeadTab = Exclude<Tab, "jobs">;

export const CONTACT_TABS = ["new", "contacted", "all"] as const;
export type ContactTab = (typeof CONTACT_TABS)[number];
export const LEAD_ORIGINS = ["import", "agent", "one_off"] as const;
export type LeadOrigin = (typeof LEAD_ORIGINS)[number];

/** The filters the left panel counts (leadFacetsOf). City/phone/e-mail are the displayed values (displayOf). */
export type FacetFilters = { contact: ContactTab; cities: string[]; levels: number[]; hasPhone: boolean; hasEmail: boolean; origins: LeadOrigin[] };

export type LeadFilters = FacetFilters & {
  q: string;
  temperature: Temperature | "all";
  agent: "all" | "one_off" | string;
  status: LeadStatus | "all";
  tab: LeadTab;
  minLevel: 0 | 1 | 2 | 3 | 4;
};

export const DEFAULT_LEAD_FILTERS: LeadFilters = {
  q: "", temperature: "all", agent: "all", status: "all", tab: "all", minLevel: 0,
  contact: "all", cities: [], levels: [], hasPhone: false, hasEmail: false, origins: [],
};

export type FacetCount<T> = { value: T; n: number };
export type LeadFacets = {
  tabs: Record<ContactTab, number>;
  cities: FacetCount<string>[];
  levels: FacetCount<number>[];
  phone: number;
  email: number;
  origins: FacetCount<LeadOrigin>[];
};

const filtersSchema = z.object({
  q: z.string().max(200),
  temperature: z.string().max(20),
  agent: z.string().max(60),
  status: z.string().max(20),
  tab: z.string().max(20),
  minLevel: z.number().int().min(0).max(4),
  contact: z.enum(CONTACT_TABS),
  cities: z.array(z.string().max(120)).max(50),
  levels: z.array(z.number().int().min(0).max(4)).max(5),
  hasPhone: z.boolean(),
  hasEmail: z.boolean(),
  origins: z.array(z.enum(LEAD_ORIGINS)).max(3),
}).partial();

/** A saved view's filters over the defaults; anything unreadable falls back to the default. */
export function parseLeadFilters(raw: unknown): LeadFilters {
  const r = filtersSchema.safeParse(raw);
  return r.success ? ({ ...DEFAULT_LEAD_FILTERS, ...r.data } as LeadFilters) : DEFAULT_LEAD_FILTERS;
}

/** Left-panel and tab rules: trimmed display values (as lead_contact_values reads them), never-contacted = "new". */
export function matchesFacets(i: Pick<LeadListItem, "lead" | "display">, f: FacetFilters): boolean {
  const contacted = i.lead.first_contacted_at !== null;
  if (f.contact === "new" ? contacted : f.contact === "contacted" ? !contacted : false) return false;
  const city = i.display.city?.trim() || null;
  if (f.cities.length > 0 && (city === null || !f.cities.includes(city))) return false;
  if (f.levels.length > 0 && !f.levels.includes(i.lead.level)) return false;
  if (f.hasPhone && !i.display.phone?.trim()) return false;
  if (f.hasEmail && !i.display.email?.trim()) return false;
  if (f.origins.length > 0 && !f.origins.includes(i.lead.origin_kind)) return false;
  return true;
}

function fold(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** What to show for a lead: the best candidate's values first; otherwise the oldest non-refuted field of each kind. */
export function displayOf(best: CandidateRow | null, fields: LeadFieldRow[]): LeadDisplay {
  const oldest = (kind: LeadFieldRow["field"]): string | null => {
    let pick: LeadFieldRow | null = null;
    for (const f of fields) {
      if (f.field !== kind || f.status === "refuted") continue;
      if (!pick || Date.parse(f.seen_at) < Date.parse(pick.seen_at)) pick = f;
    }
    return pick?.value ?? null;
  };
  return {
    name: best?.name ?? oldest("name") ?? t.leads.noName,
    city: best?.city ?? oldest("city"),
    phone: best?.phone ?? oldest("phone"),
    website: best?.website ?? oldest("website"),
    email: best?.public_email ?? oldest("email"),
  };
}

/** A lead with no research candidate (import-only) shows only in "Todos". */
export function leadInTab(i: Pick<LeadListItem, "best">, tab: LeadTab): boolean {
  return i.best ? inTab(i.best, tab) : tab === "all";
}

/** Every filter except the left-panel ones (tabs and facets are counted on top of these). */
function otherFiltersOf(f: LeadFilters): (i: LeadListItem) => boolean {
  const q = fold(f.q.trim());
  const qDigits = f.q.replace(/\D/g, "");
  return ({ lead, best, display }) => {
    if (!leadInTab({ best }, f.tab)) return false;
    if (f.temperature !== "all" && (!best || best.temperature !== f.temperature)) return false;
    if (f.status !== "all" && lead.status !== f.status) return false;
    if (f.minLevel > 0 && lead.level < f.minLevel) return false;
    if (f.agent === "one_off" ? lead.origin_kind !== "one_off" : f.agent !== "all" && lead.origin_agent_id !== f.agent) return false;
    if (q) {
      const phone = (display.phone ?? "").replace(/\D/g, "");
      const hit = fold(display.name).includes(q) || fold(display.city ?? "").includes(q) || (qDigits.length > 0 && phone.includes(qDigits));
      if (!hit) return false;
    }
    return true;
  };
}

export function filterLeads(items: LeadListItem[], f: LeadFilters): LeadListItem[] {
  const other = otherFiltersOf(f);
  return items
    .filter((i) => other(i) && matchesFacets(i, f))
    .sort((a, b) => (a.best && b.best ? byTemperature(a.best, b.best) : a.best ? -1 : b.best ? 1 : a.display.name.localeCompare(b.display.name)));
}

function countBy<T>(rows: LeadListItem[], key: (i: LeadListItem) => T | null): FacetCount<T>[] {
  const m = new Map<T, number>();
  for (const i of rows) {
    const k = key(i);
    if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([value, n]) => ({ value, n }));
}

export const TOP_CITIES = 12;

/**
 * Counts for the tabs and the left panel over the leads already loaded: each facet with every OTHER filter applied (its
 * own left out, so a picked value never hides its siblings); the tabs with every filter except the tab itself.
 */
export function leadFacetsOf(items: LeadListItem[], f: LeadFilters): LeadFacets {
  const other = otherFiltersOf(f);
  const base = items.filter(other);
  const without = (patch: Partial<FacetFilters>) => base.filter((i) => matchesFacets(i, { ...f, ...patch }));
  const tabRows = without({ contact: "all" });
  const contacted = tabRows.filter((i) => i.lead.first_contacted_at !== null).length;
  return {
    tabs: { new: tabRows.length - contacted, contacted, all: tabRows.length },
    cities: countBy(without({ cities: [] }), (i) => i.display.city?.trim() || null)
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
      .slice(0, TOP_CITIES),
    levels: countBy(without({ levels: [] }), (i) => i.lead.level).sort((a, b) => b.value - a.value),
    phone: without({ hasPhone: false }).filter((i) => i.display.phone?.trim()).length,
    email: without({ hasEmail: false }).filter((i) => i.display.email?.trim()).length,
    origins: countBy(without({ origins: [] }), (i) => i.lead.origin_kind).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)),
  };
}

export function originLabel(i: Pick<LeadListItem, "lead" | "agentName"> & { importName?: string | null }): string {
  if (i.lead.origin_kind === "import") return i.importName ? fill(t.leads.imported, { list: i.importName }) : t.leads.importedNoList;
  return i.agentName ?? t.leads.oneOff;
}

/** toCsv writes CandidateRows; a lead without a candidate becomes an all-null row built from what the list shows. */
function csvRowOf(i: LeadListItem): CandidateRow {
  if (i.best) return i.best;
  const d = i.display;
  return {
    id: i.lead.id, run_id: "", name: d.name, name_key: "", city: d.city, state: null, region: null, website: d.website, phone: d.phone,
    public_email: d.email, email_type: null, company_type: "other", size_note: null, temperature: null, approach: null, ask_for_name: null,
    ask_for_title: null, name_confidence: null, name_source_url: null, name_note: null, permit_count: null, total_value_usd: null,
    last_permit_date: null, biggest_job_address: null, biggest_job_value_usd: null, biggest_job_type: null, biggest_job_description: null,
    signal_match: null, google_rating: null, review_count: null, hook: null, supplier_portal_url: null, notes: null, user_decision: "pending",
    second_pass: null, is_partial: false, verified_at: null, entry_path: null, found_at_url: null, found_at_title: null,
    found_at_excerpt: null, found_at_seen_at: null, phone_source_url: null, email_source_url: null, rating_source_url: null,
  };
}

export function leadsCsv(items: LeadListItem[]): string {
  // toCsv reads one row per lead, so status and agent are looked up by row id (candidate id, or lead id when there is none).
  const rows = items.map(csvRowOf);
  const byId = new Map(items.map((i, n) => [rows[n].id, i]));
  const extra: Column[] = [
    { id: "leadStatus", header: "Status", kind: "text", compact: false, get: (c) => { const i = byId.get(c.id); return i ? t.leads.statuses[i.lead.status] : null; } },
    { id: "leadAgent", header: "Agente", kind: "text", compact: false, get: (c) => { const i = byId.get(c.id); return i ? originLabel(i) : null; } },
  ];
  return toCsv(rows, [...SHEET_COLUMNS, ...extra]);
}
