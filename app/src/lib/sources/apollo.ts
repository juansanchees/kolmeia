// Apollo FREE organization lookup (F3d Task 5): pure TypeScript, HTTP behind an injected seam, never calls the network itself.
// Every assumption that was NOT confirmed with a real key lives in the ADAPTER block below and is marked "?".
// TODO: confirmar com chave real do Apollo (Task 5 Step 0) - path, auth header, response keys, plan access.
import { nameKey } from "@/lib/research/dedupe";
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import type { HttpJson } from "./http";
import type { ImportRowIn } from "./types";

type HttpResponse = { status: number; json: unknown };

// ---------- ADAPTER: everything unverified (?) is here ----------
const APOLLO_BASE = "https://api.apollo.io"; // ?
const SEARCH_PATH = "/api/v1/mixed_companies/search"; // ? worked via Apollo MCP; REST free-plan access unknown
const HEALTH_PATH = "/api/v1/auth/health"; // ? key test
const KEY_HEADER = "X-Api-Key"; // ?
const DISPLAY_MODE = "fuzzy_select_mode"; // free lookup mode; never call mixed_companies without it
const PER_PAGE = 25;
const TIMEOUT_MS = 10_000;
/** ? Response keys that may hold the list (the first array found wins). */
const LIST_KEYS = ["organizations", "accounts"] as const;
/** ? Item keys. */
const NAME_KEYS = ["name"] as const;
const DOMAIN_KEYS = ["primary_domain", "domain"] as const;
const WEBSITE_KEYS = ["website_url"] as const;
/** ? Body error code returned when the plan does not include the endpoint ("not included in your Free plan"). */
const PLAN_ERROR_CODE = "API_INACCESSIBLE";
// ----------------------------------------------------------------

export const APOLLO_PLAN_MESSAGE = "Seu plano do Apollo não libera esta busca pela API";
export const APOLLO_KEY_MESSAGE = "Chave recusada pelo serviço. Confira e cole de novo.";

/** The plan blocks the endpoint (or the key lacks the permission). Message is fixed text: never carries key or response body. */
export class ApolloPlanError extends Error {
  constructor() {
    super(APOLLO_PLAN_MESSAGE);
    this.name = "ApolloPlanError";
  }
}
/** The key was refused (401). Fixed text. */
export class ApolloKeyError extends Error {
  constructor() {
    super(APOLLO_KEY_MESSAGE);
    this.name = "ApolloKeyError";
  }
}
/** Any other failure: status only (0 = transport), never body, URL or key. */
export class ApolloError extends Error {
  status: number;
  constructor(status: number) {
    super(`Apollo respondeu com erro (${status})`);
    this.name = "ApolloError";
    this.status = status;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (o: Record<string, unknown>, keys: readonly string[]): string => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** 2-letter TLDs common for US companies: allowed like .us. */
const ALLOWED_CC = new Set(["us", "io", "ai", "co"]);

/** A 2-letter last label outside ALLOWED_CC is a foreign ccTLD (acme.co.uk, x.com.pk, y.ca). A junk filter, not a country test. */
export function isForeignDomain(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.+$/, "").split(".");
  const tld = labels[labels.length - 1] ?? "";
  return /^[a-z]{2}$/.test(tld) && !ALLOWED_CC.has(tld);
}

/** null = junk (no name, no domain and no website, foreign ccTLD). Never carries a phone; social-profile URLs are dropped by sanitizeUrl. */
export function mapOrg(item: unknown, row = 1): ImportRowIn | null {
  if (!isObj(item)) return null;
  const name = str(item, NAME_KEYS);
  if (!name) return null;
  const domain = str(item, DOMAIN_KEYS).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const site = sanitizeUrl(str(item, WEBSITE_KEYS)) ?? (domain ? sanitizeUrl(`https://${domain}`) : null);
  const host = site ? hostOf(site) : null;
  if (!host) return null;
  if (isForeignDomain(host)) return null;
  const nk = nameKey(name);
  if (!nk) return null;
  return { row, name, name_key: nk, website: site as string };
}

export function apolloClient(key: string, http: HttpJson) {
  const headers = { [KEY_HEADER]: key, "Content-Type": "application/json", Accept: "application/json" };

  async function call(req: { url: string; method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let res: HttpResponse;
    try {
      res = await http.request(req.method, req.url, { headers, body: req.body, timeoutMs: TIMEOUT_MS });
    } catch {
      throw new ApolloError(0); // the underlying message could echo the request: fixed text only
    }
    const code = isObj(res.json) ? res.json.error_code : undefined;
    if (code === PLAN_ERROR_CODE || (res.status === 403 && code === undefined)) throw new ApolloPlanError();
    if (res.status === 401) throw new ApolloKeyError();
    if (res.status < 200 || res.status >= 300) throw new ApolloError(res.status);
    return res.json;
  }

  return {
    /** Does the key work at all? Throws ApolloKeyError / ApolloPlanError / ApolloError. */
    async checkKey(): Promise<true> {
      await call({ url: APOLLO_BASE + HEALTH_PATH, method: "GET" });
      return true;
    },
    /** One page (25) of organizations, raw items. Free lookup only: never enriches. */
    async lookup(q: { locations: string[]; naics: string[]; page: number }): Promise<unknown[]> {
      const json = await call({
        url: APOLLO_BASE + SEARCH_PATH,
        method: "POST",
        body: {
          display_mode: DISPLAY_MODE,
          organization_locations: q.locations,
          organization_naics_codes: q.naics,
          page: q.page,
          per_page: PER_PAGE,
        },
      });
      if (!isObj(json)) return [];
      for (const k of LIST_KEYS) if (Array.isArray(json[k])) return json[k] as unknown[];
      return [];
    },
  };
}
