import { z } from "zod";
import { usd } from "@/components/research/format";
import { fill, t } from "@/messages/pt";

// Pure helpers of the "Buscar" screens: labels, form parsing. No I/O. The database repeats every limit.

const S = t.sources;
export type Kind = "maps" | "apollo";

/** Same formula as the database (enqueue_source_run): the most a Maps run may cost. MAPS_USD_PER_PLACE is a "?" estimate. */
const MAPS_USD_PER_PLACE = 0.004;
const MAPS_MIN_USD = 0.5;
export const mapsReserve = (max: number): number => Math.max(MAPS_MIN_USD, Math.ceil(max * MAPS_USD_PER_PLACE * 100) / 100);

/** "até US$ 0,50" for Maps; Apollo's free lookup has no dollar cost. */
export function estimateLabel(kind: Kind, max: number): string {
  if (kind === "apollo") return S.search.estimateApollo;
  return fill(S.estimate, { usd: usd(mapsReserve(max)) });
}

type RunStatusIn = { status: string; error: string | null };

const known = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** "na fila", "rodando", "importada", "falhou · demorou demais", "recusada · teto do dia". Unknown codes become "erro". */
export function runStatusLabel(row: RunStatusIn): string {
  const base = known(S.runStatus, row.status) ? S.runStatus[row.status as keyof typeof S.runStatus] : S.runStatus.failed;
  if ((row.status !== "failed" && row.status !== "refused") || !row.error) return base;
  const code = row.error.toLowerCase().replace("-", "_");
  const reason = known(S.runError, code) ? S.runError[code as keyof typeof S.runError] : code.startsWith("http_") ? S.runError.failed : S.runError.other;
  return `${base} · ${reason}`;
}

type Conn = { provider: "apify" | "apollo"; today: number | null; cap: number | null };

/** "Hoje: US$ 1,20 de 2,00" / "Hoje: 3 de 20 buscas"; "?" when the database did not say. */
export function todayLine(c: Conn): string {
  if (c.provider === "apify") return fill(S.todayUsd, { spent: c.today === null ? "?" : usd(c.today), cap: c.cap === null ? "?" : usd(c.cap) });
  return fill(S.todayCalls, { n: c.today === null ? "?" : c.today, cap: c.cap === null ? "?" : c.cap });
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The label the user typed, else what was searched. */
export function runTitle(r: { kind: string; query: Record<string, unknown> }): string {
  const label = typeof r.query.label === "string" ? r.query.label.trim() : "";
  if (label) return label;
  if (r.kind === "maps") return [strs(r.query.terms).join(", "), typeof r.query.location === "string" ? r.query.location : ""].filter(Boolean).join(" · ");
  return [strs(r.query.locations).join(", "), strs(r.query.naics).join(", ")].filter(Boolean).join(" · ") || S.search.kindApollo;
}

// ---------------------------------------------------------------- forms

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
const naics = z.array(z.string().regex(/^[0-9]{2,5}$/)).max(5);
const places = z.array(z.string().min(1).max(120)).max(5);
const text = (v: unknown) => (typeof v === "string" ? v : "");

const mapsForm = z.object({ terms, location: place, max: intText(1, 200), label });
export type MapsQuery = { terms: string[]; location: string; label?: string };
export type ApolloQuery = { locations: string[]; naics: string[]; pages: number; label?: string };
export type Enqueue<Q> = { query: Q; max: number };

export function parseMapsForm(i: { terms?: unknown; location?: unknown; max?: unknown; label?: unknown }): Parsed<Enqueue<MapsQuery>> {
  const r = mapsForm.safeParse({ terms: splitList(i.terms), location: text(i.location), max: text(i.max) || "50", label: text(i.label) || undefined });
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
    mapsMax: text(i.mapsMax) || "50",
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
