// Pure mappers: private CSVs -> KbItem for public.kb_ingest. No I/O, no network. Rows that must not enter the base are
// counted in `skipped` (never silently dropped). People carry name/title/license only (D13); a person's phone, e-mail
// and address are never mapped.
import { parseCsv } from "@/lib/leads/baseline";
import { nameKey } from "@/lib/research/dedupe";
import { KB_SOURCES, type KbCompanyInput, type KbItem, type KbSignalInput, type KbSource, type KbValueInput, type Mapped } from "./types";

export const MAPS_CATEGORIES = ["General contractor", "Construction company", "Contractor", "Real estate developer", "Home builder", "Custom home builder", "Remodeler", "Kitchen remodeler", "Bathroom remodeler", "Interior construction contractor", "Modular home builder", "Metal construction company", "Steel construction company", "Home and construction"];

// Ported verbatim from data/ma_sweep/scripts/name_utils.py (JUNK_EXACT, JUNK_RE, is_junk, BOSTON_TOKENS).
const JUNK_EXACT = new Set(["OWNER", "HOMEOWNER", "HOME OWNER", "SELF", "N/A", "NA", "N A", "TBD", "NONE", "UNKNOWN", "OWNER BUILDER", "OWNER/BUILDER", "OWNERBUILDER", "TO BE DETERMINED", "TBA", "NOT APPLICABLE", "NOT SPECIFIED", "XX", "X", "-", "--", ".", "OWNER OCCUPANT", "PROPERTY OWNER", "THE OWNER", "OWNER-BUILDER", "BUILDER", "CONTRACTOR", "SAME", "SAME AS ABOVE", "AS ABOVE", "N/A N/A", "NULL", "NOT LISTED", "NO CONTRACTOR", "HOME OWNER SELF"]);
const JUNK_RE = /^(OWNER\b|HOME ?OWNER|SELF\b|CITY OF\b|TOWN OF\b|COMMONWEALTH OF\b|STATE OF\b|COUNTY OF\b|DEPARTMENT OF\b|DEPT\b|\w+ (PUBLIC SCHOOLS|SCHOOL DEPARTMENT|HOUSING AUTHORITY|DPW|DEPARTMENT)$)/i;
const COMPANY_TOKENS = new Set(["LLC", "INC", "CORP", "CO", "CONSTRUCTION", "BUILDERS", "BUILDING", "CONTRACTING", "CONTRACTORS", "DEVELOPMENT", "PROPERTIES", "GROUP", "ASSOCIATES", "DESIGN", "REMODELING", "RESTORATION", "CARPENTRY", "HOMES", "REALTY"]);

export function isJunkName(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim().toUpperCase();
  if (n.length < 2) return true;
  const n2 = n.replace(/[^A-Z0-9/ ]/g, "").trim();
  return JUNK_EXACT.has(n) || JUNK_EXACT.has(n2) || JUNK_RE.test(n) || JUNK_RE.test(n2) || !/[A-Z]/.test(n);
}
export function hasCompanyToken(name: string): boolean {
  return name.toUpperCase().replace(/\./g, "").replace(/[^A-Z0-9& ]/g, " ").split(/\s+/).some((t) => COMPANY_TOKENS.has(t));
}

/** Any source outside the D8 allowlist throws. */
export function assertKbSource(s: string): KbSource {
  if (!(KB_SOURCES as readonly string[]).includes(s)) throw new Error(`source not allowed: ${s}`);
  return s as KbSource;
}

type Rec = Record<string, string>;
function records(csv: string): Rec[] {
  const [head, ...rows] = parseCsv(csv);
  if (!head) return [];
  const h = head.map((x) => x.trim());
  return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}
const cut = (s: string | undefined, n: number): string | undefined => (s ? s.slice(0, n) : undefined);
const bump = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);
const val = (field: string, value: string | undefined, source: KbSource, seen_at: string, source_url?: string): KbValueInput[] =>
  value ? [{ field, value: value.slice(0, 1000), source, seen_at, ...(source_url ? { source_url } : {}) }] : [];
const company = (name: string, extra: Partial<KbCompanyInput> = {}): KbCompanyInput => {
  const c: KbCompanyInput = { name: name.slice(0, 200), name_key: nameKey(name) };
  for (const [k, v] of Object.entries(extra)) if (v) (c as Record<string, string>)[k] = v;
  return c;
};

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let y: string, m: string, d: string;
  const a = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const b = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (a) [, y, m, d] = a;
  else if (b) [, m, d, y] = b;
  else return undefined;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? undefined : iso;
}
function money(s: string | undefined): number | undefined {
  const n = Number((s ?? "").replace(/[$,\s]/g, ""));
  return s && Number.isFinite(n) && n >= 0 ? n : undefined;
}
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

// ---------------------------------------------------------------- maps
export function mapsItems(csv: string, seenAt: string): Mapped {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    if (!MAPS_CATEGORIES.includes(r.category)) { bump(skipped, "category"); continue; }
    if (!r.name || isJunkName(r.name) || !nameKey(r.name)) { bump(skipped, "junk"); continue; }
    const state = /^massachusetts$/i.test(r.state) ? "MA" : cut(r.state, 2);
    const url = r.place_id ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}` : undefined;
    items.push({
      company: company(r.name, { website: r.website, phone: r.phone, address: cut(r.address, 300), city: cut(r.city, 100), state, zip: cut(r.zip, 10) }),
      values: [
        ...val("name", r.name, "maps_robot", seenAt, url), ...val("phone", r.phone, "maps_robot", seenAt, url), ...val("website", r.website, "maps_robot", seenAt, url),
        ...val("address", r.address, "maps_robot", seenAt, url), ...val("city", r.city, "maps_robot", seenAt, url), ...val("zip", r.zip, "maps_robot", seenAt, url),
        ...val("category", r.category, "maps_robot", seenAt, url),
      ],
    });
  }
  return { items, skipped };
}

// ---------------------------------------------------------------- companies.csv (aggregated permit contractors)
export function companiesItems(csv: string, seenAt: string): Mapped {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    if (r.looks_like_individual === "1" && r.mapped_from_person !== "1") { bump(skipped, "individual"); continue; }
    if (!r.company || isJunkName(r.company) || !nameKey(r.company)) { bump(skipped, "junk"); continue; }
    items.push({ company: company(r.company), values: [...val("name", r.company, "permit", seenAt), ...val("license", r.license, "permit", seenAt)] });
  }
  return { items, skipped };
}

// ---------------------------------------------------------------- permits (BRIEF schema, private collectors)
const cutDesc = (s: string) => cut(s, 300);
export function permitItems(csv: string, variants: Map<string, string>): Mapped {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    if (!r.contractor_name || isJunkName(r.contractor_name)) { bump(skipped, "junk"); continue; }
    const canon = variants.get(nameKey(r.contractor_name));
    if (!canon) { bump(skipped, "unknown_contractor"); continue; }
    if (!r.permit_id) { bump(skipped, "no_permit_id"); continue; }
    const sig: KbSignalInput = clean({
      kind: "permit" as const, source: "permit" as const, source_ref: `${r.source}:${r.permit_id}`.slice(0, 120), address: r.address, town: r.town,
      value_usd: money(r.declared_value_usd), work_class: r.work_class, use: r.use, issued_on: isoDate(r.issued_date), description: cutDesc(r.description), source_url: r.source_url, permit_no: cut(r.permit_id, 60),
    });
    items.push({ match_only: true, company: company(canon), signals: [sig] });
  }
  return { items, skipped };
}

// ---------------------------------------------------------------- projects
const projectRef = (source: string, name: string, role: string) => `${source}:${name.slice(0, 120 - source.length - role.length - 2)}#${role}`;
function projectSignals(r: Rec, role: string): KbSignalInput {
  const units = Number(r.units);
  // The ingest has no units column: keep it in the description so the offer rule can read "N units".
  const desc = [Number.isFinite(units) && units > 0 && !/units?\b/i.test(r.description) ? `${units} units` : "", r.description].filter(Boolean).join(". ");
  return clean({
    kind: "project" as const, source: "project" as const, source_ref: projectRef(r.source, r.project_name, role), address: r.address, town: r.town,
    value_usd: money(r.value_usd), work_class: r.project_type, issued_on: isoDate(r.key_date), description: cutDesc(desc), source_url: r.source_url,
  });
}
export function projectItems(csv: string, seenAt: string): Mapped {
  void seenAt;
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    if (!r.project_name) { bump(skipped, "no_project_name"); continue; }
    for (const [col, type, role] of [["general_contractor", "gc", "gc"], ["developer", "developer", "dev"]] as const) {
      const name = r[col];
      if (!name) continue;
      if (isJunkName(name) || !nameKey(name)) { bump(skipped, "junk"); continue; }
      items.push({ company: company(name, { company_type: type }), signals: [projectSignals(r, role)] });
    }
  }
  return { items, skipped };
}

/** MassBuilds projects of one town. A project with no usable GC or developer is kept as a company-less signal (the SDR asks who builds it). */
export function massbuildsProjectItems(csv: string, town: string): Mapped {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    if (r.town.toLowerCase() !== town.toLowerCase()) { bump(skipped, "other_town"); continue; }
    if (!r.project_name) { bump(skipped, "no_project_name"); continue; }
    let any = false;
    for (const [col, type, role] of [["general_contractor", "gc", "gc"], ["developer", "developer", "dev"]] as const) {
      const name = r[col];
      if (!name || isJunkName(name) || !nameKey(name)) continue;
      any = true;
      items.push({ company: company(name, { company_type: type }), signals: [projectSignals(r, role)] });
    }
    if (!any) items.push({ match_only: true, signals: [projectSignals(r, "none")] });
  }
  return { items, skipped };
}

// ---------------------------------------------------------------- Falmouth permit CSV (private collector)
// The applicant phone is used only to match a company in memory (`memo`); it never enters an item.
export type PermitMemo = { applicantName?: string; contractorName?: string; applicantPhone?: string };
export function falmouthPermitItems(csv: string): Mapped & { unlinked: number; memo: Record<string, PermitMemo> } {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  const memo: Record<string, PermitMemo> = {};
  let unlinked = 0;
  for (const r of records(csv)) {
    if (!r.permit_no) { bump(skipped, "no_permit_no"); continue; }
    const ref = `${r.source}:${r.permit_no}`.slice(0, 120);
    const sig: KbSignalInput = clean({
      kind: "permit" as const, source: "permit" as const, source_ref: ref, address: r.address, town: r.town,
      value_usd: money(r.value_usd), work_class: r.work_class, use: r.use, issued_on: isoDate(r.issued_on), description: cutDesc(r.description), source_url: r.source_url, permit_no: cut(r.permit_no, 60),
    });
    const contractor = r.contractor_name && !isJunkName(r.contractor_name) && nameKey(r.contractor_name) ? r.contractor_name : "";
    // No contractor: a company-looking applicant stands in; a person applicant is never stored.
    const applicantCo = !contractor && r.applicant_name && !isJunkName(r.applicant_name) && hasCompanyToken(r.applicant_name) && nameKey(r.applicant_name) ? r.applicant_name : "";
    const name = contractor || applicantCo;
    if (name) {
      if (applicantCo) sig.applicant_name = applicantCo.slice(0, 200);
      items.push({ match_only: true, company: company(name), signals: [sig] });
    } else {
      items.push({ match_only: true, signals: [sig] });
      unlinked++;
    }
    if (r.applicant_name || r.applicant_phone || r.contractor_name) memo[ref] = clean({ applicantName: r.applicant_name, contractorName: r.contractor_name, applicantPhone: r.applicant_phone });
  }
  return { items, skipped, unlinked, memo };
}

// ---------------------------------------------------------------- crosswalk (person <-> firm)
export function crosswalkItems(csv: string, seenAt: string): Mapped {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    if (r.status !== "unambiguous") { bump(skipped, "ambiguous"); continue; }
    if (!r.firm || isJunkName(r.firm) || !nameKey(r.firm) || !r.person_display || !nameKey(r.person_display)) { bump(skipped, "junk"); continue; }
    items.push({ match_only: true, company: company(r.firm), people: [clean({ name: r.person_display.slice(0, 200), name_key: nameKey(r.person_display), license: cut(r.license_number, 40), source: "crosswalk" as const, seen_at: seenAt })] });
  }
  return { items, skipped };
}

// ---------------------------------------------------------------- licenses (never reads an address column)
export function licenseItems(csv: string, seenAt: string): Mapped {
  const items: KbItem[] = [];
  const skipped: Record<string, number> = {};
  for (const r of records(csv)) {
    const source = assertKbSource(r.source);
    if (source !== "license_csl" && source !== "license_hic") throw new Error(`source not allowed for licenses: ${source}`);
    if (!r.firm) { bump(skipped, "individual"); continue; }
    if (isJunkName(r.firm) || !nameKey(r.firm)) { bump(skipped, "junk"); continue; }
    items.push({
      company: company(r.firm, { city: cut(r.city, 100), state: cut(r.state, 2) }),
      values: val("name", r.firm, source, seenAt, r.source_url || undefined),
      people: r.name && nameKey(r.name) ? [clean({ name: r.name.slice(0, 200), name_key: nameKey(r.name), title: cut(r.license_type, 120), license: cut(r.license_number, 40), source, source_url: r.source_url || undefined, seen_at: seenAt })] : undefined,
    });
  }
  return { items, skipped };
}
