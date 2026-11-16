import "server-only";
import { Resolver } from "node:dns/promises";
import { domainOf, emailSyntaxOk, mxVerdict, normalizeEmail, type DnsAnswer, type MxStatus } from "./email-quality";

// The free e-mail check (Fase 2, item 7): syntax, then one MX (and, when there is none, one A) look-up per domain.
// Never SMTP: no connection is ever opened to a mail server.

export type DnsLookup = (domain: string) => Promise<DnsAnswer>;
export type EmailVerdict = { email: string; status: MxStatus; detail: string };

/** Domains looked up at once: the rate limit of one "Checar e-mails" click. */
export const DNS_CONCURRENCY = 5;
const DNS_TIMEOUT_MS = 3000;

const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "dns");

/** The real look-up: one try, 3 s, through the system's resolvers. */
export function systemLookup(): DnsLookup {
  const r = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  return async (domain) => {
    try {
      return { mx: await r.resolveMx(domain), hasA: null, error: null };
    } catch (e) {
      const error = codeOf(e);
      if (error !== "ENODATA" && error !== "ENOTFOUND") return { mx: null, hasA: null, error };
      try {
        return { mx: null, hasA: (await r.resolve4(domain)).length > 0, error };
      } catch (e2) {
        const c = codeOf(e2);
        return { mx: null, hasA: c === "ENODATA" || c === "ENOTFOUND" ? false : null, error };
      }
    }
  };
}

/** Verdict per e-mail. Each domain is looked up once, at most DNS_CONCURRENCY at a time. */
export async function checkEmails(emails: string[], lookup: DnsLookup): Promise<EmailVerdict[]> {
  const list = [...new Set(emails.map(normalizeEmail))];
  const domains = [...new Set(list.filter(emailSyntaxOk).map(domainOf))];
  const byDomain = new Map<string, { status: MxStatus; detail: string }>();
  let next = 0;
  const worker = async () => {
    while (next < domains.length) {
      const d = domains[next++];
      byDomain.set(d, mxVerdict(await lookup(d).catch((): DnsAnswer => ({ mx: null, hasA: null, error: "dns" }))));
    }
  };
  await Promise.all(Array.from({ length: Math.min(DNS_CONCURRENCY, domains.length) }, worker));
  return list.map((email) => (emailSyntaxOk(email) ? { email, ...byDomain.get(domainOf(email))! } : { email, status: "invalid" as const, detail: "syntax" }));
}

/** Addresses per DNS-and-save round: each round is stored before the next starts, so a timeout keeps the work done. */
export const SAVE_CHUNK = 25;
/** A free verdict is reused this long; 'unknown' never is (it is retried), a verifier verdict always is. */
export const FRESH_MS = 7 * 86_400_000;

type Known = { status: string; method: string; checked_at: string };

/**
 * Which addresses one click looks up: every address not freshly known, at most `max`. `skipped` = freshly known,
 * `cut` = left for the next click by the cap.
 */
export function planEmailCheck(emails: string[], known: Map<string, Known>, now: number, max: number): { todo: string[]; skipped: number; cut: number } {
  const list = [...new Set(emails.map(normalizeEmail))].filter((e) => e.length >= 3 && e.length <= 254);
  const fresh = (e: string) => {
    const k = known.get(e);
    return Boolean(k && (k.method === "verifier" || (k.status !== "unknown" && now - Date.parse(k.checked_at) < FRESH_MS)));
  };
  const stale = list.filter((e) => !fresh(e));
  return { todo: stale.slice(0, max), skipped: list.length - stale.length, cut: Math.max(0, stale.length - max) };
}
