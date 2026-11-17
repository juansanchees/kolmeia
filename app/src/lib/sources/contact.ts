// Apify contact scraper (vdrmota~contact-info-scraper) for the Qualificador's step P2b: input builder and e-mail filter.
// Pure. Only e-mails are kept (phones and social links are never read), and only the ones the lead's own site shows.
import { hostOf, sanitizeUrl } from "@/lib/safe-url";

export const CONTACT_ACTOR = "vdrmota~contact-info-scraper";
/** Leads that share one run (and so its 0.50 minimum charge). */
export const CONTACT_MAX_LEADS = 10;
/** Reserve of one contact run (Apify's minimum). */
export const CONTACT_RESERVE_USD = 0.5;
/** E-mails kept per lead. */
const PER_LEAD = 3;
/** Pages the actor may return for one run (5 per site x 10 sites). */
export const CONTACT_MAX_ITEMS = CONTACT_MAX_LEADS * 5;

export function contactInput(urls: string[]): object {
  return {
    startUrls: urls.map((url) => ({ url })),
    maxRequestsPerStartUrl: 5,
    maxDepth: 1,
    sameDomain: true,
    mergeContacts: true,
    proxyConfig: { useApifyProxy: true },
  };
}

const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/;

/** Placeholder, image-name and tracking addresses that sites and builders leave in their markup. */
function junk(email: string): boolean {
  if (IMAGE.test(email)) return true;
  const host = email.slice(email.lastIndexOf("@") + 1);
  const labels = host.split(".");
  if (labels[0] === "example") return true;
  if (host === "domain.com") return true;
  if (host === "wixpress.com" || host.endsWith(".wixpress.com")) return true;
  if (labels.some((l) => l === "sentry" || l.startsWith("sentry-"))) return true;
  return false;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Mailboxes small contractors really use. Kept only when read on the lead's own page (never from a third party's). */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "comcast.net", "verizon.net", "att.net",
]);

/** Social, review and directory sites: a lead whose "website" is one of these has no site of its own to scrape. */
const DIRECTORY_HOSTS = ["facebook.com", "fb.com", "instagram.com", "yelp.com", "bbb.org", "houzz.com", "angi.com", "angieslist.com", "thumbtack.com", "nextdoor.com", "google.com", "goo.gl", "g.page", "business.site"];
const BLOCKED_NETWORK = /linked[\s_.-]*in|lnkd/i;

export function isDirectoryHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  return BLOCKED_NETWORK.test(h) || DIRECTORY_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The address, normalised, when it may be stored for a site: on the site's own domain, or a free-mail one read on its own page. */
export function ownSiteEmail(e: unknown, siteHost: string, onOwnPage: boolean): string | null {
  if (typeof e !== "string") return null;
  const email = e.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email) || junk(email)) return null;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return sameSite(domain, siteHost) || (onOwnPage && FREE_MAIL.has(domain)) ? email : null;
}

export const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * The e-mails to store, per lead. An e-mail is kept when its domain is the lead's domain, or when it is a free-mail
 * address (gmail, yahoo...) read on a page of the lead's own site. Everything else is dropped: with mergeContacts and
 * sameDomain nearly every item is a page of the lead's host, so "read on the own site" alone would also let through a web
 * agency's footer, a manufacturer's rep or a directory's address. Leads that share one site all get its e-mails.
 */
export function keepEmails(items: unknown[], leads: { leadId: string; host: string }[]): { leadId: string; value: string; url: string }[] {
  if (!Array.isArray(items)) return [];
  const byHost = new Map<string, string[]>();
  for (const l of leads) {
    const h = l.host.toLowerCase().replace(/^www\./, "");
    byHost.set(h, [...(byHost.get(h) ?? []), l.leadId]);
  }
  const out: { leadId: string; value: string; url: string }[] = [];
  const seen = new Set<string>();
  const count = new Map<string, number>();
  for (const raw of items) {
    const it = rec(raw);
    if (!it || !Array.isArray(it.emails)) continue;
    const start = typeof it.originalStartUrl === "string" ? hostOf(it.originalStartUrl) : null;
    const page = typeof it.url === "string" ? hostOf(it.url) : null;
    const siteHost = start && byHost.has(start) ? start : page && byHost.has(page) ? page : null;
    if (!siteHost) continue;
    const pageUrl = typeof it.url === "string" ? sanitizeUrl(it.url) : null;
    if (!pageUrl) continue;
    const onOwnPage = !!page && sameSite(page, siteHost);
    for (const e of it.emails) {
      const email = ownSiteEmail(e, siteHost, onOwnPage);
      if (!email) continue;
      for (const leadId of byHost.get(siteHost)!) {
        const k = `${leadId}:${email}`;
        if (seen.has(k) || (count.get(leadId) ?? 0) >= PER_LEAD) continue;
        seen.add(k);
        count.set(leadId, (count.get(leadId) ?? 0) + 1);
        out.push({ leadId, value: email, url: pageUrl });
      }
    }
  }
  return out;
}
