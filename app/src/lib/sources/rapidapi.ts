// RapidAPI: ONE key, two APIs. Pure TypeScript, HTTP behind the injected seam.
//   B2B Lead Finder (b2b-lead-finder-for-cold-email): decision-makers of companies, one page per call.
//   Website Contact Finder (website-contact-finder): the e-mails a company's own site shows, one site per call.
// Parameter names and values: the provider's playground (checked by the owner 2026-11-17) and its docs gist. Every
// request counts against the RapidAPI plan, so there is no free "test the key" call: the key is checked by shape only.
import { z } from "zod";
import { pickEmail } from "@/lib/imports/rows";
import { matchesName } from "@/lib/leads/email-quality";
import { nameKey } from "@/lib/research/dedupe";
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import type { HttpJson } from "./http";
import { ownSiteEmail, sameSite } from "./contact";
import type { ImportRowIn } from "./types";
import type { B2bQuery, B2bSector, B2bState } from "./view";

const B2B_HOST = "b2b-lead-finder-for-cold-email.p.rapidapi.com";
const SITE_HOST = "website-contact-finder.p.rapidapi.com";
const B2B_TIMEOUT_MS = 30_000;
const SITE_TIMEOUT_MS = 10_000;
/** E-mails kept per site. */
const PER_SITE = 3;

/** Fixed short code only (never a body, URL or key): "key" | "http_<n>" (429 = plan limit) | "network" | "bad_response". */
export class RapidApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`rapidapi_${code}`);
    this.name = "RapidApiError";
    this.code = code;
  }
}

/** UF -> the API's state value and the name its answers use. */
const STATES: Record<B2bState, { api: string; name: string }> = {
  MA: { api: "Massachusetts", name: "Massachusetts" },
  CT: { api: "Connecticut", name: "Connecticut" },
  RI: { api: "Rhode_Island", name: "Rhode Island" },
  NH: { api: "New_Hampshire", name: "New Hampshire" },
  ME: { api: "Maine", name: "Maine" },
  VT: { api: "Vermont", name: "Vermont" },
  NY: { api: "New_York", name: "New York" },
};
/** Sector presets -> the API's industry values (several = comma-separated). */
const INDUSTRIES: Record<B2bSector, string[]> = {
  construction: ["Building_Construction"], // one value: comma-joined values are not verified
  real_estate: ["Property_Management", "Real_Estate_Investment_and_Development", "Other_-_Real_Estate"],
  architecture: ["Architecture_and_Planning"],
};

/** The query string of one B2B call. Filters not chosen are left out (the API then does not filter on them). */
export function b2bParams(q: Pick<B2bQuery, "state" | "sector" | "size" | "role">, page: number): URLSearchParams {
  const st = STATES[q.state];
  return new URLSearchParams({
    companyLocation: st.api,
    companyIndustries: INDUSTRIES[q.sector].join(","),
    companySize: q.size,
    contactSeniority: q.role,
    pageNumber: String(Math.max(1, Math.floor(page) || 1)),
  });
}

// Untrusted record: every field optional; a wrong type drops the field, never the row. Profile-link fields are not read.
const optStr = z.string().optional().catch(undefined);
const personSchema = z.object({
  Name: optStr,
  "First Name": optStr,
  "Last Name": optStr,
  Email: optStr,
  "Job Title": optStr,
  City: optStr,
  State: optStr,
  Country: optStr,
  "Company Name": optStr,
  "Company Location": optStr,
  "Company Industry": optStr,
  "Company Domain": optStr,
});

const cap = (v: string | undefined, n: number): string | undefined => {
  const s = v?.trim();
  return s ? Array.from(s).slice(0, n).join("") : undefined; // by code point: never a lone surrogate
};
const fold = (s: string) => s.trim().toLowerCase();

/**
 * One person -> one import row (null = dropped). Only people in the United States; when the company's location is
 * given it must be in the chosen state, else the person's own state must be (when given). The company is the lead; the
 * person is its contact (name, title, work e-mail). URLs pass sanitizeUrl.
 */
export function mapDecisionMaker(item: unknown, state: B2bState, row = 1): ImportRowIn | null {
  const r = personSchema.safeParse(item);
  if (!r.success) return null;
  const p = r.data;
  if (fold(p.Country ?? "") !== "united states") return null;
  const want = STATES[state].name.toLowerCase();
  const where = p["Company Location"]?.toLowerCase();
  if (where ? !where.includes(want) : p.State && ![want, state.toLowerCase()].includes(fold(p.State))) return null;

  const name = cap(p["Company Name"], 200);
  const nk = name ? nameKey(name) : "";
  if (!name || !nk) return null;
  const out: ImportRowIn = { row, name, name_key: nk };

  const domain = cap(p["Company Domain"], 253)?.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const url = domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? sanitizeUrl(`https://${domain}`) : null;
  if (url && url.length <= 300) out.website = url;
  const parts = (p["Company Location"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const city = parts.length >= 3 ? cap(parts[0], 300) : cap(p.City, 300);
  if (city) out.city = city;
  out.state = state;
  const contact = cap(p.Name, 300) ?? cap([p["First Name"], p["Last Name"]].filter(Boolean).join(" "), 300);
  if (contact) out.contact_name = contact;
  const title = cap(p["Job Title"], 300);
  if (title) out.contact_title = title;
  const email = pickEmail(p.Email ?? "");
  if (email && email.length <= 300) out.email = email;
  const industry = cap(p["Company Industry"]?.replace(/_/g, " "), 300);
  if (industry) out.company_type = industry;
  return out;
}

const b2bSchema = z.object({
  leads: z.array(z.unknown()),
  summary: z.object({ invalidInputs: z.record(z.string(), z.unknown()).catch({}) }).partial().catch({}).optional(),
});
const siteSchema = z.object({
  data: z.object({
    contact: z.object({ emails: z.array(z.unknown()).catch([]) }).partial().catch({}).optional(),
    sources: z.object({ emails: z.array(z.unknown()).catch([]) }).partial().catch({}).optional(),
  }),
});
const sourceSchema = z.object({ value: z.string(), occurrences: z.number().optional().catch(undefined), best_source: z.string().optional().catch(undefined) });

const GENERIC = /^(info|office|contact|contactus|sales|admin|hello|service|services|support|mail|email|team|jobs|careers|hr|billing|accounts?|estimating|bids?|inquiries|enquiries|marketing|webmaster|noreply|no-reply)$/;


/**
 * The e-mails of one site, best first: the contact's own mailbox, then personal-looking ones, then generic ones
 * (info@, office@...), each with the page it was read on (else the site itself). Kept only when they belong to the
 * site (ownSiteEmail); at most 3.
 */
export function siteEmails(json: unknown, siteUrl: string, contactName?: string | null): { value: string; url: string }[] {
  const site = sanitizeUrl(siteUrl);
  const host = site ? hostOf(site) : null;
  const r = siteSchema.safeParse(json);
  if (!site || !host || !r.success) return [];
  const found = new Map<string, { value: string; url: string; n: number }>();
  for (const raw of r.data.data.sources?.emails ?? []) {
    const s = sourceSchema.safeParse(raw);
    if (!s.success) continue;
    const page = s.data.best_source ? sanitizeUrl(s.data.best_source) : null;
    const pageHost = page ? hostOf(page) : null;
    const onOwnPage = !!pageHost && sameSite(pageHost, host);
    const email = ownSiteEmail(s.data.value, host, onOwnPage);
    if (email && !found.has(email)) found.set(email, { value: email, url: onOwnPage && page && page.length <= 2000 ? page : site, n: s.data.occurrences ?? 0 });
  }
  for (const e of r.data.data.contact?.emails ?? []) {
    const email = ownSiteEmail(e, host, false); // no page known: a free-mail address is not proof
    if (email && !found.has(email)) found.set(email, { value: email, url: site, n: 0 });
  }
  const rank = (e: string) => (matchesName(e, contactName) ? 0 : GENERIC.test(e.slice(0, e.indexOf("@"))) ? 2 : 1);
  return [...found.values()]
    .sort((a, b) => rank(a.value) - rank(b.value) || b.n - a.n)
    .slice(0, PER_SITE)
    .map(({ value, url }) => ({ value, url }));
}

/** What the quota headers say is left (the smaller of credits and requests), or null when they say nothing. */
export function quotaLeft(headers: Record<string, string> | undefined): number | null {
  const n = ["x-ratelimit-credits-remaining", "x-ratelimit-requests-remaining"]
    .map((k) => headers?.[k])
    .filter((v): v is string => typeof v === "string" && /^\d+$/.test(v.trim()))
    .map(Number);
  return n.length ? Math.min(...n) : null;
}

export function rapidApiClient(key: string, http: HttpJson) {
  async function get(host: string, path: string, params: URLSearchParams, timeoutMs: number) {
    let res: { status: number; json: unknown; headers?: Record<string, string> };
    try {
      res = await http.request("GET", `https://${host}${path}?${params.toString()}`, {
        headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host, Accept: "application/json" },
        timeoutMs,
      });
    } catch {
      throw new RapidApiError("network"); // the transport message could echo the request: fixed text only
    }
    if (res.status === 401 || res.status === 403) throw new RapidApiError("key");
    if (res.status < 200 || res.status >= 300) throw new RapidApiError(`http_${res.status}`);
    return res;
  }

  return {
    /** One B2B page: the raw people (map them with mapDecisionMaker). */
    async decisionMakers(q: Pick<B2bQuery, "state" | "sector" | "size" | "role">, page: number): Promise<unknown[]> {
      const r = b2bSchema.safeParse((await get(B2B_HOST, "/coldEmailFinder", b2bParams(q, page), B2B_TIMEOUT_MS)).json);
      if (!r.success) throw new RapidApiError("bad_response");
      // a filter the API did not take would still return people, unfiltered: nothing is imported
      if (Object.keys(r.data.summary?.invalidInputs ?? {}).length > 0) throw new RapidApiError("bad_query");
      return r.data.leads.slice(0, 200);
    },
    /** One site: the raw answer (read it with siteEmails) and what the plan says is left. */
    async siteContacts(url: string): Promise<{ json: unknown; left: number | null }> {
      const p = new URLSearchParams({ url, contact: "true", sources: "true", profile: "false", visuals: "false", meta: "false" });
      const res = await get(SITE_HOST, "/", p, SITE_TIMEOUT_MS);
      return { json: res.json, left: quotaLeft(res.headers) };
    },
  };
}
