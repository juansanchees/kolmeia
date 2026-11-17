// The e-mail cascade (Fase 2, item 6). Stops at the first step that gives an e-mail:
//   1 'site'     an e-mail already on file (scraped from the lead's site, or from a list/research), never a guess;
//                the contact's own mailbox (jdoe@ for "Jane Doe") wins over the other ones;
//   1b 'queued'  the lead has its own site: RapidAPI's site reader is asked (async, the sources clock reads it; the
//                e-mails come back as 'rapidapi_contact' values and step 1 finds them on the next click). Skipped when
//                RapidAPI is not connected, the month's sites are used up or the site was already read (30 days);
//   2 'pattern'  guesses from the contact's name + the site's domain, stored as lead_fields source 'pattern'
//                (unverified; the campaign gate refuses them, 0028 email_sendable);
//   3 'verifier' the paid verifier (EMAIL_VERIFIER) checks the guesses; the first 'verified' one becomes sendable.
// No network of its own: DNS, the verifier and the writes are injected (tests use fakes).
import { sanitizeUrl } from "@/lib/safe-url";
import type { DnsLookup } from "./email-check";
import { emailSyntaxOk, matchesName, mxVerdict, ownDomain, patternCandidates, type VerifierStatus } from "./email-quality";
import type { EmailVerifier } from "./email-verifier";
import type { LeadFieldRow, LeadListItem } from "./types";

export type FindEmailStep = "site" | "queued" | "pattern" | "verifier" | "none";
export type FindEmailResult = {
  leadId: string;
  step: FindEmailStep;
  /** The e-mail the step found (step 1 or 3). */
  email: string | null;
  /** Where step 1's e-mail came from (the lead_fields source, or 'research'). */
  source: string | null;
  /** Step 2's guesses (all of them, new and already stored). */
  guesses: string[];
  reason: "no_contact" | "no_domain" | "dead_domain" | null;
};

export type GuessRow = { leadId: string; email: string; pattern: string; excerpt: string };
export type CascadeDeps = {
  lookup: DnsLookup;
  verifier: EmailVerifier | null;
  addGuesses: (rows: GuessRow[]) => Promise<void>;
  /** Server-side only (record_verifier_verdict): a verifier verdict never goes through the user's session. */
  saveVerdict: (email: string, status: VerifierStatus) => Promise<void>;
  /** Addresses already checked 'invalid' in this workspace: step 1 never returns them. */
  invalid?: Set<string>;
  /** Step 1b: ask RapidAPI to read the lead's own site. true = queued; false = not available for this lead. */
  readSite?: (leadId: string, url: string) => Promise<boolean>;
};

/** Site-scraped values first, then the rest; newest first inside each group. */
const SITE_SOURCES = ["rapidapi_contact", "apify_contact", "site"];

const live = (fields: LeadFieldRow[], kind: LeadFieldRow["field"]) =>
  fields
    .filter((f) => f.field === kind && f.status !== "refuted")
    .sort((a, b) => Number(SITE_SOURCES.includes(b.source)) - Number(SITE_SOURCES.includes(a.source)) || Date.parse(b.seen_at) - Date.parse(a.seen_at));

export async function findEmailFor(item: LeadListItem, fields: LeadFieldRow[], deps: CascadeDeps): Promise<FindEmailResult> {
  const leadId = item.lead.id;
  const base = { leadId, email: null, source: null, guesses: [], reason: null };

  // 1: an e-mail on file that is not a guess
  const usable = (e: string) => emailSyntaxOk(e) && !deps.invalid?.has(e);
  const contact = item.best?.ask_for_name?.trim() || live(fields, "contact_name")[0]?.value.trim() || null;
  const onFiles = live(fields, "email").filter((f) => f.source !== "pattern" && usable(f.value.trim().toLowerCase()));
  const onFile = onFiles.find((f) => matchesName(f.value, contact)) ?? onFiles[0];
  if (onFile) return { ...base, step: "site", email: onFile.value.trim().toLowerCase(), source: onFile.source };
  const researched = item.best?.public_email?.trim().toLowerCase();
  if (researched && usable(researched)) return { ...base, step: "site", email: researched, source: "research" };

  // 1b: the e-mail the lead's own site shows (RapidAPI), before any guess
  const website = item.best?.website ?? live(fields, "website")[0]?.value ?? item.display.website;
  const domain = ownDomain(website);
  const siteUrl = domain && website ? sanitizeUrl(website.includes("://") ? website : `https://${website}`) : null;
  if (siteUrl && deps.readSite && (await deps.readSite(leadId, siteUrl))) return { ...base, step: "queued" };

  // 2: guesses from the contact's name and the lead's own domain
  if (!contact) return { ...base, step: "none", reason: "no_contact" };
  if (!domain) return { ...base, step: "none", reason: "no_domain" };
  if (mxVerdict(await deps.lookup(domain)).status === "invalid") return { ...base, step: "none", reason: "dead_domain" };
  const candidates = patternCandidates(contact, domain);
  if (candidates.length === 0) return { ...base, step: "none", reason: "no_contact" };
  const stored = new Set(fields.filter((f) => f.field === "email" && f.source === "pattern").map((f) => f.value.trim().toLowerCase()));
  const fresh = candidates.filter((c) => !stored.has(c.email));
  if (fresh.length > 0) {
    await deps.addGuesses(fresh.map((c) => ({ leadId, email: c.email, pattern: c.pattern, excerpt: `${c.pattern}@${domain} a partir de "${contact}"`.slice(0, 300) })));
  }
  const guesses = candidates.map((c) => c.email);

  // 3: the paid verifier, when configured; the first 'verified' guess wins
  if (deps.verifier) {
    for (const g of guesses) {
      const status = await deps.verifier.verify(g);
      await deps.saveVerdict(g, status);
      if (status === "verified") return { ...base, step: "verifier", email: g, guesses };
    }
  }
  return { ...base, step: "pattern", guesses };
}

/** One lead at a time: bounded DNS and verifier traffic per click. */
export async function findEmails(leads: { item: LeadListItem; fields: LeadFieldRow[] }[], deps: CascadeDeps): Promise<FindEmailResult[]> {
  const out: FindEmailResult[] = [];
  for (const l of leads) out.push(await findEmailFor(l.item, l.fields, deps));
  return out;
}
