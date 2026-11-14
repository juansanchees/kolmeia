import "server-only";
import { hostOf, isBlockedHost, sanitizeUrl } from "@/lib/safe-url";
import { extractFromHtml, type SiteFacts } from "./extract";
import type { RawHttp, RawResponse } from "./net";
import { parseRobots, robotsAllows, type RobotsRules } from "./robots";

// P2: read a company's own public site. Plain HTTP only (no cookies, forms, logins, JS or proxies), public addresses
// only, robots.txt honoured, one request per second per host, bounded time and size. Every outcome is a value, never
// a throw: a site that blocks or is down is information, not an error.

export const SITE_LIMITS = { timeoutMs: 5000, maxBytes: 1_000_000, maxRedirects: 3, maxPages: 4, perHostGapMs: 1000 } as const;
export const USER_AGENT = "KolmeiaBot/1.0 (+https://kolmeia.solutions/bot)";
const ROBOTS_AGENT = "KolmeiaBot";
const HTML_ACCEPT = "text/html,application/xhtml+xml";

export type SiteRead = {
  outcome: "ok" | "no_site" | "site_blocked" | "robots" | "site_down" | "not_html" | "error";
  pages: { url: string; text: string; facts: SiteFacts }[];
  finalHome: string | null;
};

export type SiteDeps = { http: RawHttp; sleep: (ms: number) => Promise<void>; now: () => number; gaps: Map<string, number> };

type Fail = "site_blocked" | "robots" | "site_down" | "not_html" | "error";
type Fetched = { ok: true; url: string; res: RawResponse } | { ok: false; outcome: Fail };

const BLOCK_STATUS = new Set([401, 403, 429, 503]);
const DOWN_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "timeout", "blocked_address"]);

const errCode = (e: unknown): string => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/** A URL we are willing to request: clean, public-looking host, default port only. */
function allowedUrl(raw: string): URL | null {
  const clean = sanitizeUrl(raw);
  if (!clean) return null;
  const u = new URL(clean);
  if (isBlockedHost(u.hostname)) return null;
  if (u.port !== "" && u.port !== "80" && u.port !== "443") return null;
  return u;
}

export async function readSite(website: string, deps: SiteDeps): Promise<SiteRead> {
  const robotsCache = new Map<string, RobotsRules | "allow">();
  const fail = (outcome: SiteRead["outcome"]): SiteRead => ({ outcome, pages: [], finalHome: null });

  async function polite(url: URL, accept: string): Promise<RawResponse> {
    const host = url.hostname;
    const last = deps.gaps.get(host);
    if (last !== undefined) {
      const wait = SITE_LIMITS.perHostGapMs - (deps.now() - last);
      if (wait > 0) await deps.sleep(wait);
    }
    deps.gaps.set(host, deps.now());
    return deps.http.get(url.toString(), { timeoutMs: SITE_LIMITS.timeoutMs, maxBytes: SITE_LIMITS.maxBytes, userAgent: USER_AGENT, accept });
  }

  /** Rules for an origin, or the outcome that stops the read. */
  async function rulesFor(url: URL): Promise<RobotsRules | "allow" | Fail> {
    const cached = robotsCache.get(url.origin);
    if (cached) return cached;
    let res: RawResponse;
    try {
      res = await polite(new URL("/robots.txt", url.origin), "text/plain");
    } catch (e) {
      const c = errCode(e);
      return c === "timeout" ? "robots" : DOWN_CODES.has(c) ? "site_down" : "robots";
    }
    let rules: RobotsRules | "allow";
    if (res.status >= 200 && res.status < 300) rules = parseRobots(res.body, ROBOTS_AGENT);
    else if (res.status >= 400 && res.status < 500 && res.status !== 429) rules = "allow";
    else return "robots"; // 5xx, 429, odd 3xx: we cannot know, so we do not read
    robotsCache.set(url.origin, rules);
    return rules;
  }

  /** GET with manual redirects; robots read before any page body, on every host reached. */
  async function fetchPage(start: URL): Promise<Fetched> {
    let url = start;
    for (let hop = 0; ; hop++) {
      const rules = await rulesFor(url);
      if (typeof rules === "string" && rules !== "allow") return { ok: false, outcome: rules };
      if (rules !== "allow" && !robotsAllows(rules, url.pathname + url.search)) return { ok: false, outcome: "robots" };
      let res: RawResponse;
      try {
        res = await polite(url, HTML_ACCEPT);
      } catch (e) {
        const c = errCode(e);
        if (c === "blocked_address" && hop > 0) return { ok: false, outcome: "error" };
        return { ok: false, outcome: DOWN_CODES.has(c) ? "site_down" : "error" };
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers["location"];
        if (!loc || hop >= SITE_LIMITS.maxRedirects) return { ok: false, outcome: "error" };
        let next: URL | null = null;
        try {
          next = allowedUrl(new URL(loc, url).toString());
        } catch {
          next = null;
        }
        if (!next) return { ok: false, outcome: "error" };
        url = next;
        continue;
      }
      return { ok: true, url: url.toString(), res };
    }
  }

  const home = allowedUrl(typeof website === "string" ? website : "");
  if (!home) return fail("no_site");

  const first = await fetchPage(home);
  if (!first.ok) return fail(first.outcome);
  const pageOutcome = judge(first.res);
  if (pageOutcome) return fail(pageOutcome);

  const homeFacts = extractFromHtml(first.res.body, first.url);
  if (looksLikeChallenge(first.res.body, homeFacts.text)) return fail("site_blocked");
  const pages: SiteRead["pages"] = [{ url: first.url, text: homeFacts.text, facts: homeFacts }];
  const seen = new Set<string>([first.url]);
  const homeHost = hostOf(first.url);

  for (const link of homeFacts.links) {
    if (pages.length >= SITE_LIMITS.maxPages) break;
    const u = allowedUrl(link);
    if (!u || hostOf(u.toString()) !== homeHost || seen.has(u.toString())) continue;
    const r = await fetchPage(u);
    if (!r.ok || judge(r.res) || hostOf(r.url) !== homeHost || seen.has(r.url)) continue;
    const facts = extractFromHtml(r.res.body, r.url);
    if (looksLikeChallenge(r.res.body, facts.text)) continue;
    seen.add(r.url);
    pages.push({ url: r.url, text: facts.text, facts });
  }
  return { outcome: "ok", pages, finalHome: first.url };
}

/** Outcome that ends the read for a response, or null when it is a usable HTML page. */
function judge(res: RawResponse): Fail | null {
  if (BLOCK_STATUS.has(res.status)) return "site_blocked";
  if (res.status < 200 || res.status >= 300) return "site_down";
  const type = (res.headers["content-type"] ?? "").toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml") ? null : "not_html";
}

/** Bot-wall pages. "captcha" alone is common on real pages (contact forms), so it only counts on a near-empty page. */
function looksLikeChallenge(html: string, text: string): boolean {
  if (/cf-chl|Attention Required/i.test(html)) return true;
  return text.length < 1500 && /captcha/i.test(html);
}
