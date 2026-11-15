// URL hygiene for anything that came from the web or from an AI (rules R11 and R15).
// Only http(s), no credentials, no IP-literal or internal hosts, no blocked professional network (never stored, never shown), bounded
// length. The database applies the same rules (public.is_safe_url / public.url_host in 0004); the shared vector
// list in tests/fixtures/url-vectors.ts keeps both sides in step.

import { BLOCKED_NETWORK_HOSTS } from "@/lib/blocked-network";

const MAX_URL = 2000;
const BLOCKED_HOSTS = BLOCKED_NETWORK_HOSTS;
/** Names that only resolve inside a private network. */
const INTERNAL_SUFFIXES = ["localhost", "local", "internal", "localdomain", "lan", "home.arpa", "intranet", "corp"];

/** Host as the URL parser sees it, lower-case, without trailing dots ("example.com." is "example.com"). */
function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.+$/, "");
}

/** Lower-case host without a leading "www." or trailing dots, or null when the string is not an http(s) URL. */
export function hostOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return bareHost(u).replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  return BLOCKED_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
}

/** IPv4 / IPv6 literals and private-network names are never a company's public page. */
export function isIpOrInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (h.startsWith("[") || h.includes(":")) return true; // IPv6 literal
  if (/(^|\.)(0x[0-9a-f]*|\d+)$/.test(h)) return true; // last label numeric: IPv4 in any notation
  if (!h.includes(".")) return true; // single-label names
  return INTERNAL_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Returns a clean absolute http(s) URL, or null. Rejects javascript:, data:, ftp:, relative URLs, URLs with
 * embedded credentials, whitespace, IP-literal and internal hosts, and any blocked-network host (trailing dots included).
 */
export function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL || /\s/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = bareHost(u);
  if (isIpOrInternalHost(host) || isBlockedHost(host)) return null;
  u.hostname = host;
  const out = u.toString();
  return out.length <= MAX_URL ? out : null;
}

/** Query parameters that only track the click; they never change which page it is. */
const TRACKING_PARAM = /^(utm_[a-z_]+|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|srsltid)$/i;

/**
 * Key used to compare a cited URL with the URLs the web tools actually returned (finding 3). Same page = same key:
 * http and https, host case, a leading "www.", a trailing dot on the host, the default port, the fragment, a
 * trailing slash and click-tracking parameters (utm_*, gclid, fbclid, srsltid...) do not matter. The path and the
 * other query parameters do. null if not http(s).
 */
export function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = bareHost(u).replace(/^www\./, "");
    const port = u.port && u.port !== "443" && u.port !== "80" ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/+$/, "");
    const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k));
    const search = params.length === [...u.searchParams].length ? u.search : params.length ? `?${new URLSearchParams(params)}` : "";
    return `https://${host}${port}${path}${search}`;
  } catch {
    return null;
  }
}

/** "https://host" for a URL whose path is the site root (no path, no query), else null. */
export function rootOf(raw: string): string | null {
  const k = urlKey(raw);
  if (!k) return null;
  const u = new URL(k);
  return u.pathname === "" || u.pathname === "/" ? (u.search ? null : `https://${u.host}`) : null;
}
