// E-mail quality (Fase 2, item 7) and pattern guesses (item 6). Pure and client-safe: no DNS, no network.
import { hostOf } from "@/lib/safe-url";
import { isDirectoryHost } from "@/lib/sources/contact";

/**
 * 'verified' and 'catch_all' only come from the paid verifier (a mailbox verdict). The free check can only say
 * 'domain_ok' (the domain takes mail), 'unknown' or 'invalid'; it never calls an address valid.
 */
export const EMAIL_QUALITIES = ["verified", "domain_ok", "catch_all", "unknown", "invalid"] as const;
export type EmailQuality = (typeof EMAIL_QUALITIES)[number];
export type MxStatus = Extract<EmailQuality, "domain_ok" | "unknown" | "invalid">;
export type VerifierStatus = Exclude<EmailQuality, "domain_ok">;

/** Same shape as public.is_email_address (0003), so what passes here passes the campaign gate's syntax check. */
const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailSyntaxOk(email: string): boolean {
  return email.length >= 6 && email.length <= 254 && EMAIL.test(email);
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** What one DNS look-up of a domain found. `error` is the resolver's code (ENODATA, ENOTFOUND, ETIMEOUT...). */
export type DnsAnswer = { mx: { exchange: string; priority: number }[] | null; hasA: boolean | null; error: string | null };

const NO_RECORD = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

/**
 * The free verdict for a domain. MX present = 'domain_ok' (the domain takes mail; the mailbox itself is never probed).
 * A null MX (RFC 7505, a single "." record) or no MX and no A = 'invalid'. A only, timeouts and server failures =
 * 'unknown'. Catch-all needs a mailbox probe, so only the paid verifier can say it.
 */
export function mxVerdict(a: DnsAnswer): { status: MxStatus; detail: string } {
  if (a.mx && a.mx.length > 0) {
    if (a.mx.length === 1 && (a.mx[0].exchange === "" || a.mx[0].exchange === ".")) return { status: "invalid", detail: "null_mx" };
    return { status: "domain_ok", detail: "mx" };
  }
  const missing = a.mx !== null || (a.error !== null && NO_RECORD.has(a.error));
  if (!missing) return { status: "unknown", detail: a.error ?? "dns" };
  if (a.hasA === true) return { status: "unknown", detail: "a_only" };
  if (a.hasA === false) return { status: "invalid", detail: "no_mx_no_a" };
  return { status: "unknown", detail: "dns" };
}

/** The lead's own mail domain from its website ("https://www.acme.com/x" -> "acme.com"), or null for directories/social pages. */
export function ownDomain(website: string | null | undefined): string | null {
  const host = website ? hostOf(website.includes("://") ? website : `https://${website}`) : null;
  if (!host || isDirectoryHost(host)) return null;
  const d = host.toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d) ? d : null;
}

function nameParts(contactName: string): string[] {
  return contactName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|jr|sr|ii|iii|iv)\b\.?/g, " ")
    .split(/[^a-z]+/)
    .filter((p) => p.length > 0);
}

/** Is this address the contact's own mailbox in one of the usual company patterns (jdoe@, john.doe@, john@...)? */
export function matchesName(email: string, contactName: string | null | undefined): boolean {
  const e = email.trim().toLowerCase();
  return patternCandidates(contactName, e.slice(e.lastIndexOf("@") + 1)).some((c) => c.email === e);
}

/** Step 2 of the cascade: the usual company patterns. Guesses only: never verified, never sent until the verifier says so. */
export function patternCandidates(contactName: string | null | undefined, domain: string | null): { email: string; pattern: string }[] {
  if (!contactName || !domain) return [];
  const parts = nameParts(contactName);
  if (parts.length === 0) return [];
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : null;
  const shapes: [string, string | null][] = [
    ["first.last", last && `${first}.${last}`],
    ["first", first],
    ["flast", last && `${first[0]}${last}`],
    ["firstlast", last && `${first}${last}`],
    ["f.last", last && `${first[0]}.${last}`],
  ];
  const out: { email: string; pattern: string }[] = [];
  for (const [pattern, local] of shapes) {
    const email = local ? `${local}@${domain}` : null;
    if (email && emailSyntaxOk(email) && !out.some((o) => o.email === email)) out.push({ email, pattern });
  }
  return out;
}
