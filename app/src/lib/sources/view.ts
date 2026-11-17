import { z } from "zod";
import { usd } from "@/components/research/format";
import { fill, t } from "@/messages/pt";

// Pure helpers of the "Buscar" screens: labels, form parsing. No I/O. The database repeats every limit.

const S = t.sources;
export type Kind = "maps" | "apollo" | "shovels" | "b2b";

/** Same formula as the database (enqueue_source_run): the most a Maps run may cost. MAPS_USD_PER_PLACE is a "?" estimate. */
const MAPS_USD_PER_PLACE = 0.004;
const MAPS_MIN_USD = 0.5;
export const mapsReserve = (max: number): number => Math.max(MAPS_MIN_USD, Math.ceil(max * MAPS_USD_PER_PLACE * 100) / 100);

/** "até US$ 0,50" for Maps; Apollo's free lookup and Shovels' free plan have no dollar cost. */
export function estimateLabel(kind: Kind, max: number): string {
  if (kind === "apollo") return S.search.estimateApollo;
  if (kind === "shovels") return S.search.estimateShovels;
  if (kind === "b2b") return S.search.estimateB2b;
  return fill(S.estimate, { usd: usd(mapsReserve(max)) });
}

type RunStatusIn = { status: string; error: string | null };

const known = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** "na fila", "rodando", "importada", "falhou · demorou demais", "recusada · teto atingido". Unknown codes become "erro". */
export function runStatusLabel(row: RunStatusIn): string {
  const base = known(S.runStatus, row.status) ? S.runStatus[row.status as keyof typeof S.runStatus] : S.runStatus.failed;
  if ((row.status !== "failed" && row.status !== "refused") || !row.error) return base;
  const code = row.error.toLowerCase().replace("-", "_");
  const reason = known(S.runError, code) ? S.runError[code as keyof typeof S.runError] : code.startsWith("http_") ? S.runError.failed : S.runError.other;
  return `${base} · ${reason}`;
}

type Conn = { provider: "apify" | "apollo" | "shovels" | "rapidapi" | "rapidapi_sites"; today: number | null; cap: number | null };

/** "Hoje: US$ 1,20 de 2,00" / "Hoje: 3 de 20 buscas" / "120 de 500 usados este mês" (Shovels); "?" when the database did not say. */
export function todayLine(c: Conn): string {
  if (c.provider === "rapidapi") return fill(S.monthCalls, { n: c.today === null ? "?" : c.today, cap: c.cap === null ? "?" : c.cap });
  if (c.provider === "rapidapi_sites") return fill(S.monthSites, { n: c.today === null ? "?" : c.today, cap: c.cap === null ? "?" : c.cap });
  if (c.provider === "shovels") return fill(S.monthRecords, { n: c.today === null ? "?" : c.today, cap: c.cap === null ? "?" : c.cap });
  if (c.provider === "apify") return fill(S.todayUsd, { spent: c.today === null ? "?" : usd(c.today), cap: c.cap === null ? "?" : usd(c.cap) });
  return fill(S.todayCalls, { n: c.today === null ? "?" : c.today, cap: c.cap === null ? "?" : c.cap });
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The label the user typed, else what was searched. */
export function runTitle(r: { kind: string; query: Record<string, unknown> }): string {
  const label = typeof r.query.label === "string" ? r.query.label.trim() : "";
  if (label) return label;
  if (r.kind === "maps") return [strs(r.query.terms).join(", "), typeof r.query.location === "string" ? r.query.location : ""].filter(Boolean).join(" · ");
  if (r.kind === "shovels") {
    const tag = SHOVELS_TAGS.includes(r.query.tag as ShovelsTag) ? S.search.tags[r.query.tag as ShovelsTag] : "";
    return [typeof r.query.place === "string" && r.query.place ? r.query.place : "MA", tag].filter(Boolean).join(" · ");
  }
  if (r.kind === "b2b") {
    const sector = (B2B_SECTORS as readonly string[]).includes(String(r.query.sector)) ? S.search.sectors[r.query.sector as B2bSector] : "";
    return [sector, typeof r.query.state === "string" ? r.query.state : "", typeof r.query.page === "number" ? fill(S.search.page, { n: r.query.page }) : ""].filter(Boolean).join(" · ");
  }
  return [strs(r.query.locations).join(", "), strs(r.query.naics).join(", ")].filter(Boolean).join(" · ") || S.search.kindApollo;
}

// ---------------------------------------------------------------- forms

// Shovels presets and place parsing live here (no API host): the browser form uses them, shovels.ts re-exports them.
export const SHOVELS_TAGS = ["all", "new_construction", "hvac"] as const;
export type ShovelsTag = (typeof SHOVELS_TAGS)[number];

export type PlaceLookup = { geoId: string } | { lookup: "cities" | "counties"; q: string } | null;

/**
 * Massachusetts only. "" / "MA" / "Massachusetts" = the whole state; a MA ZIP (01xxx-02xxx) is a geo_id as is;
 * "... County" looks up a county; anything else looks up a city. null = not a MA place.
 */
export function placeQuery(raw: string): PlaceLookup {
  const p = raw.trim().replace(/\s+/g, " ").replace(/(?:,\s*|\s+)(MA|Mass\.?|Massachusetts)$/i, "").trim();
  if (!p || /^(MA|Massachusetts)$/i.test(p)) return { geoId: "MA" };
  if (/^\d{5}$/.test(p)) return /^0[12]\d{3}$/.test(p) ? { geoId: p } : null;
  if (p.length > 80 || !/^[\p{L} .'-]+$/u.test(p)) return null;
  return /\bcounty$/i.test(p) ? { lookup: "counties", q: p } : { lookup: "cities", q: p };
}


export type Parsed<T> = { ok: true; value: T } | { ok: false };

/** One value per line (commas and semicolons also split), trimmed, empties dropped. */
export function splitList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(/[\n\r,;]+/).map((x) => x.trim()).filter(Boolean);
}

const intText = (min: number, max: number) =>
  z.string().trim().regex(/^[0-9]{1,4}$/).transform(Number).pipe(z.number().int().min(min).max(max));
const label = z.string().trim().max(60).optional();
const terms = z.array(z.string().min(1).max(80)).min(1).max(5);
const place = z.string().trim().min(1).max(120);
const naics = z.array(z.string().regex(/^[0-9]{2,6}$/)).max(5);
const places = z.array(z.string().min(1).max(120)).max(5);
const text = (v: unknown) => (typeof v === "string" ? v : "");

const mapsForm = z.object({ terms, location: place, max: intText(1, 200), label });
export type MapsQuery = { terms: string[]; location: string; label?: string };
export type ApolloQuery = { locations: string[]; naics: string[]; pages: number; label?: string };
export type Enqueue<Q> = { query: Q; max: number };

export function parseMapsForm(i: { terms?: unknown; location?: unknown; max?: unknown; label?: unknown }): Parsed<Enqueue<MapsQuery>> {
  const r = mapsForm.safeParse({ terms: splitList(i.terms), location: text(i.location), max: text(i.max), label: text(i.label) || undefined });
  if (!r.success) return { ok: false };
  const query: MapsQuery = { terms: r.data.terms, location: r.data.location };
  if (r.data.label) query.label = r.data.label;
  return { ok: true, value: { query, max: r.data.max } };
}

const apolloForm = z
  .object({ locations: places, naics, pages: intText(1, 4), label })
  .refine((v) => v.locations.length + v.naics.length > 0);

/** Apollo returns 25 companies a page: max = 25 x pages (the same as the Caçador's own runs). */
export function parseApolloForm(i: { locations?: unknown; naics?: unknown; pages?: unknown; label?: unknown }): Parsed<Enqueue<ApolloQuery>> {
  const r = apolloForm.safeParse({ locations: splitList(i.locations), naics: splitList(i.naics), pages: text(i.pages) || "1", label: text(i.label) || undefined });
  if (!r.success) return { ok: false };
  const query: ApolloQuery = { locations: r.data.locations, naics: r.data.naics, pages: r.data.pages };
  if (r.data.label) query.label = r.data.label;
  return { ok: true, value: { query, max: r.data.pages * 25 } };
}

export type ShovelsQuery = { place: string; tag: ShovelsTag; label?: string };
const shovelsForm = z.object({ place: z.string().trim().max(80), tag: z.enum(SHOVELS_TAGS), max: intText(1, 100), label });

/** Shovels: a MA place ("" = the whole state), a permit-type preset, how many contractors (1 record = 1 credit). */
export function parseShovelsForm(i: { place?: unknown; tag?: unknown; max?: unknown; label?: unknown }): Parsed<Enqueue<ShovelsQuery>> {
  const r = shovelsForm.safeParse({ place: text(i.place), tag: text(i.tag) || "all", max: text(i.max), label: text(i.label) || undefined });
  if (!r.success || !placeQuery(r.data.place)) return { ok: false };
  const query: ShovelsQuery = { place: r.data.place, tag: r.data.tag };
  if (r.data.label) query.label = r.data.label;
  return { ok: true, value: { query, max: r.data.max } };
}

// RapidAPI B2B presets (no API host here: the browser form uses them; rapidapi.ts maps them to the API's values).
export const B2B_STATES = ["MA", "CT", "RI", "NH", "ME", "VT", "NY"] as const;
export const B2B_SECTORS = ["construction", "real_estate", "architecture"] as const;
export const B2B_SIZES = ["1-10", "11-50", "51-200", "201-500"] as const;
export const B2B_ROLES = ["founder", "partner", "c-suite", "director", "manager"] as const;
export type B2bState = (typeof B2B_STATES)[number];
export type B2bSector = (typeof B2B_SECTORS)[number];
export type B2bQuery = { state: B2bState; sector: B2bSector; size: (typeof B2B_SIZES)[number]; role: (typeof B2B_ROLES)[number]; label?: string };
const b2bForm = z.object({ state: z.enum(B2B_STATES), sector: z.enum(B2B_SECTORS), size: z.enum(B2B_SIZES), role: z.enum(B2B_ROLES), label });

/** B2B decision-makers: one call = one page of up to 100 people (the database picks the page). */
export function parseB2bForm(i: { state?: unknown; sector?: unknown; size?: unknown; role?: unknown; label?: unknown }): Parsed<Enqueue<B2bQuery>> {
  const r = b2bForm.safeParse({ state: text(i.state), sector: text(i.sector), size: text(i.size), role: text(i.role), label: text(i.label) || undefined });
  if (!r.success) return { ok: false };
  const { label: l, ...query } = r.data;
  return { ok: true, value: { query: l ? { ...query, label: l } : query, max: 100 } };
}

export type AgentSourcesView = {
  maps_on: boolean;
  maps_terms: string[];
  maps_location: string;
  maps_max: number;
  apollo_on: boolean;
  apollo_locations: string[];
  apollo_naics: string[];
  apollo_pages: number;
};

export const DEFAULT_AGENT_SOURCES: AgentSourcesView = {
  maps_on: false,
  maps_terms: [],
  maps_location: "",
  maps_max: 50,
  apollo_on: false,
  apollo_locations: [],
  apollo_naics: [],
  apollo_pages: 1,
};

export type AgentSourcesInput = {
  agent?: unknown;
  /** false = that provider's fields were not on the form (not connected): its settings are left untouched. */
  maps?: boolean;
  apollo?: boolean;
  mapsOn?: unknown;
  mapsTerms?: unknown;
  mapsLocation?: unknown;
  mapsMax?: unknown;
  apolloOn?: unknown;
  apolloLocations?: unknown;
  apolloNaics?: unknown;
  apolloPages?: unknown;
};
export type AgentSourcesPayload = Partial<{
  maps_on: boolean;
  maps_terms: string[] | null;
  maps_location: string | null;
  maps_max: number;
  apollo_on: boolean;
  apollo_locations: string[];
  apollo_naics: string[];
  apollo_pages: number;
}>;

const agentSchema = z.object({
  agent: z.string().uuid(),
  mapsOn: z.boolean(),
  mapsTerms: z.array(z.string().min(1).max(80)).max(5),
  mapsLocation: z.string().trim().max(120),
  mapsMax: intText(1, 200),
  apolloOn: z.boolean(),
  apolloLocations: places,
  apolloNaics: naics,
  apolloPages: intText(1, 4),
});

/** What a Caçador searches on its own. Maps on needs terms and a place; an empty list is stored as "not set". */
export function parseAgentSources(i: AgentSourcesInput): Parsed<AgentSourcesPayload & { agent: string }> {
  const r = agentSchema.safeParse({
    agent: text(i.agent),
    mapsOn: i.mapsOn === true,
    mapsTerms: splitList(i.mapsTerms),
    mapsLocation: text(i.mapsLocation),
    mapsMax: text(i.mapsMax) || (i.maps === false ? "50" : ""),
    apolloOn: i.apolloOn === true,
    apolloLocations: splitList(i.apolloLocations),
    apolloNaics: splitList(i.apolloNaics),
    apolloPages: text(i.apolloPages) || "1",
  });
  if (!r.success) return { ok: false };
  const d = r.data;
  const withMaps = i.maps !== false;
  const withApollo = i.apollo !== false;
  if (withMaps && d.mapsOn && (d.mapsTerms.length === 0 || !d.mapsLocation)) return { ok: false };
  if (withApollo && d.apolloOn && d.apolloLocations.length + d.apolloNaics.length === 0) return { ok: false };
  const value: AgentSourcesPayload & { agent: string } = { agent: d.agent };
  if (withMaps) Object.assign(value, { maps_on: d.mapsOn, maps_terms: d.mapsTerms.length ? d.mapsTerms : null, maps_location: d.mapsLocation || null, maps_max: d.mapsMax });
  if (withApollo) Object.assign(value, { apollo_on: d.apolloOn, apollo_locations: d.apolloLocations, apollo_naics: d.apolloNaics, apollo_pages: d.apolloPages });
  return { ok: true, value };
}
