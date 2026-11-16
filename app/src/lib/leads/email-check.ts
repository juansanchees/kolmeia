import "server-only";
import { Resolver } from "node:dns/promises";
import { domainOf, emailSyntaxOk, mxVerdict, normalizeEmail, type DnsAnswer, type EmailQuality } from "./email-quality";

// The free e-mail check (Fase 2, item 7): syntax, then one MX (and, when there is none, one A) look-up per domain.
// Never SMTP: no connection is ever opened to a mail server.

export type DnsLookup = (domain: string) => Promise<DnsAnswer>;
export type EmailVerdict = { email: string; status: EmailQuality; detail: string };

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
  const byDomain = new Map<string, { status: EmailQuality; detail: string }>();
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
