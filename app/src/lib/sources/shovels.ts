// Shovels (building permits + contractors, https://docs.shovels.ai). Pure TypeScript, HTTP behind the injected seam.
// Confirmed against the OpenAPI spec (api.shovels.ai/spec/v2/openapi.production.yaml, 2026-11-16): base /v2, header
// X-API-Key, GET only, cursor pages {items, size, next_cursor}, 1 credit = 1 record returned, free plan 500 credits on a
// rolling 30-day window, 402 = credit limit exceeded.
import { z } from "zod";
import { pickEmail } from "@/lib/imports/rows";
import { nameKey, phoneKey } from "@/lib/research/dedupe";
import { sanitizeUrl } from "@/lib/safe-url";
import { fill, ptMessages } from "@/lib/i18n";
import type { HttpJson } from "./http";
import type { ImportRowIn } from "./types";
import { placeQuery, SHOVELS_TAGS, type ShovelsTag } from "./view";

export { placeQuery, SHOVELS_TAGS, type ShovelsTag };

const BASE = "https://api.shovels.ai/v2";
const KEY_HEADER = "X-API-Key";
const TIMEOUT_MS = 15_000;
/** /contractors/search accepts size 1..100. */
export const SHOVELS_MAX_PAGE = 100;
/** Permit window: permits that started in the last 12 months (permit_from / permit_to are required). */
const WINDOW_DAYS = 365;


/** Fixed short code only (never a body, URL or key): "key" | "credits" | "http_<n>" | "network" | "bad_response". */
export class ShovelsError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`shovels_${code}`);
    this.name = "ShovelsError";
    this.code = code;
  }
}

const usageSchema = z.object({ credits_used: z.number().int().min(0), credit_limit: z.number().int().min(0).nullable().optional() });
const geoSchema = z.object({ geo_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: z.string().max(300), state: z.string().max(10) });
const pageSchema = z.object({ items: z.array(z.unknown()) });

// Untrusted record: every field optional; a wrong type drops the field, never the row.
const optStr = z.string().optional().catch(undefined);
const contractorSchema = z.object({
  name: optStr,
  business_name: optStr,
  dba: optStr,
  license: optStr,
  primary_phone: optStr,
  phone: optStr,
  primary_email: optStr,
  email: optStr,
  website: optStr,
  primary_industry: optStr,
  total_job_value: z.number().nonnegative().optional().catch(undefined),
  status_tally: z.record(z.string(), z.number()).optional().catch(undefined),
  tag_tally: z.record(z.string(), z.number()).optional().catch(undefined),
  address: z
    .object({ street_no: optStr, street: optStr, city: optStr, state: optStr, zip_code: optStr })
    .optional()
    .catch(undefined),
});

export type ShovelsUsage = { used: number; limit: number | null };

/** How many records this run may ask for: never more than asked, than one page, or than the credits Shovels says are left. */
export function shovelsSize(requested: number, usage: ShovelsUsage): number {
  const left = usage.limit === null ? Infinity : Math.max(0, usage.limit - usage.used);
  return Math.max(0, Math.min(Math.floor(requested), SHOVELS_MAX_PAGE, left));
}

/** [from, to] as YYYY-MM-DD, the last WINDOW_DAYS days up to today (UTC). */
export function permitWindow(nowMs: number): { from: string; to: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(nowMs - WINDOW_DAYS * 86_400_000), to: day(nowMs) };
}

const cap = (v: string | undefined, n: number): string | undefined => {
  const s = v?.trim();
  return s ? Array.from(s).slice(0, n).join("") : undefined; // by code point: never a lone surrogate
};
const money = (cents: number) => Math.round(cents / 100).toLocaleString("pt-BR");

/** One contractor -> one import row (null = no usable name). URLs pass sanitizeUrl (social profiles and bad hosts dropped). */
export function mapContractor(item: unknown, row = 1): ImportRowIn | null {
  const r = contractorSchema.safeParse(item);
  if (!r.success) return null;
  const c = r.data;
  const name = cap(c.business_name, 200) ?? cap(c.name, 200) ?? cap(c.dba, 200);
  if (!name) return null;
  const nk = nameKey(name);
  if (!nk) return null;
  const out: ImportRowIn = { row, name, name_key: nk };

  const phone = [c.primary_phone, ...(c.phone?.split(",") ?? [])].map((s) => cap(s, 300)).find((p) => p && phoneKey(p));
  if (phone) out.phone = phone;
  const email = pickEmail(`${c.primary_email ?? ""},${c.email ?? ""}`);
  if (email && email.length <= 300) out.email = email;
  const site = cap(c.website, 300);
  const url = site ? sanitizeUrl(/^https?:\/\//i.test(site) ? site : `https://${site}`) : null;
  if (url && url.length <= 300) out.website = url;
  const a = c.address;
  const street = cap([a?.street_no, a?.street].filter(Boolean).join(" "), 300);
  if (street) out.address = street;
  const city = cap(a?.city, 300);
  if (city) out.city = city;
  const state = cap(a?.state, 300);
  if (state) out.state = state;
  const zip = cap(a?.zip_code, 300);
  if (zip) out.zip = zip;
  const industry = cap(c.primary_industry, 300);
  if (industry) out.company_type = industry;

  // stored lead note (import data): Portuguese whatever the UI language
  const N = ptMessages.sources.shovels.note;
  const tags = Object.entries(c.tag_tally ?? {})
    .filter(([k, n]) => /^[a-z_]{1,40}$/.test(k) && n > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 4)
    .map(([k]) => k.replace(/_/g, " "));
  const active = c.status_tally?.active;
  const license = cap(c.license, 40);
  const parts = [
    fill(N.active, { n: Number.isInteger(active) && (active as number) >= 0 ? (active as number) : "?" }),
    c.total_job_value !== undefined ? fill(N.value, { usd: money(c.total_job_value) }) : null,
    tags.length ? fill(N.tags, { tags: tags.join(", ") }) : null,
    license ? fill(N.license, { n: license }) : null,
  ];
  out.note = parts.filter(Boolean).join(" · ").slice(0, 1000);
  return out;
}

export function shovelsClient(key: string, http: HttpJson) {
  const headers = { [KEY_HEADER]: key, Accept: "application/json" };

  async function get(path: string, params: URLSearchParams = new URLSearchParams()): Promise<unknown> {
    const qs = params.toString();
    let res: { status: number; json: unknown };
    try {
      res = await http.request("GET", `${BASE}${path}${qs ? `?${qs}` : ""}`, { headers, timeoutMs: TIMEOUT_MS });
    } catch {
      throw new ShovelsError("network"); // the transport message could echo the request: fixed text only
    }
    if (res.status === 401 || res.status === 403) throw new ShovelsError("key");
    if (res.status === 402) throw new ShovelsError("credits");
    if (res.status === 404) return { items: [] }; // geo searches answer 404 when nothing matches
    if (res.status < 200 || res.status >= 300) throw new ShovelsError(`http_${res.status}`);
    return res.json;
  }

  async function usage(): Promise<ShovelsUsage> {
    const u = usageSchema.safeParse(await get("/usage"));
    if (!u.success) throw new ShovelsError("bad_response");
    return { used: u.data.credits_used, limit: u.data.credit_limit ?? null };
  }

  return {
    /** GET /usage: returns no records, so it should cost no credit (? not stated by the docs). 401/403 = refused; anything else that fails = unreachable. */
    async checkKey(): Promise<"ok" | "refused" | "unreachable"> {
      try {
        await usage();
        return "ok";
      } catch (e) {
        return e instanceof ShovelsError && e.code === "key" ? "refused" : "unreachable";
      }
    },
    usage,
    /** A MA place to a geo_id, or null when Shovels has no MA match. The exact name wins over the first MA match. */
    async resolvePlace(raw: string): Promise<string | null> {
      const q = placeQuery(raw);
      if (!q) return null;
      if ("geoId" in q) return q.geoId;
      const page = pageSchema.safeParse(await get(`/${q.lookup}/search`, new URLSearchParams({ q: q.q })));
      if (!page.success) throw new ShovelsError("bad_response");
      const ma = page.data.items.flatMap((i) => {
        const g = geoSchema.safeParse(i);
        return g.success && g.data.state.toUpperCase() === "MA" ? [g.data] : [];
      });
      const want = q.q.toUpperCase();
      return (ma.find((g) => g.name.split(",")[0].trim().toUpperCase() === want) ?? ma[0])?.geo_id ?? null;
    },
    /** One page of contractors with ACTIVE permits in the area and window. Raw items: map them with mapContractor. */
    async contractors(o: { geoId: string; tag: ShovelsTag; size: number; from: string; to: string }): Promise<unknown[]> {
      const p = new URLSearchParams({ geo_id: o.geoId, permit_from: o.from, permit_to: o.to, permit_status: "active", size: String(o.size) });
      if (o.tag !== "all") p.append("permit_tags", o.tag);
      const page = pageSchema.safeParse(await get("/contractors/search", p));
      if (!page.success) throw new ShovelsError("bad_response");
      return page.data.items.slice(0, o.size);
    },
  };
}
