import { describe, expect, test, vi } from "vitest";
import type { DnsAnswer, EmailQuality, VerifierStatus } from "@/lib/leads/email-quality";
import { emailSyntaxOk, mxVerdict, ownDomain, patternCandidates } from "@/lib/leads/email-quality";
import { findEmailFor, type GuessRow } from "@/lib/leads/email-cascade";
import { DEFAULT_LEAD_FILTERS, displayOf, leadFacetsOf, matchesFacets } from "@/lib/leads/view";
import type { LeadFieldRow, LeadListItem, LeadRow } from "@/lib/leads/types";

vi.mock("server-only", () => ({}));
const { checkEmails, planEmailCheck, FRESH_MS } = await import("@/lib/leads/email-check");
const { emailVerifier } = await import("@/lib/leads/email-verifier");

// Fase 2 items 6 and 7 (pure parts): free verdicts, pattern guesses, the cascade and the facet. Fictional data only.
const MX: DnsAnswer = { mx: [{ exchange: "mx.acme.example", priority: 10 }], hasA: null, error: null };
const NONE: DnsAnswer = { mx: null, hasA: false, error: "ENOTFOUND" };
const TIMEOUT: DnsAnswer = { mx: null, hasA: null, error: "ETIMEOUT" };

describe("free e-mail check (syntax + DNS, never SMTP)", () => {
  test("verdicts: MX = domain_ok (only the paid verifier says verified); null MX or no MX and no A = invalid; A only, timeouts = unknown", () => {
    expect(mxVerdict(MX).status).toBe("domain_ok");
    expect(mxVerdict({ mx: [{ exchange: ".", priority: 0 }], hasA: null, error: null })).toEqual({ status: "invalid", detail: "null_mx" });
    expect(mxVerdict(NONE)).toEqual({ status: "invalid", detail: "no_mx_no_a" });
    expect(mxVerdict({ mx: null, hasA: true, error: "ENODATA" }).status).toBe("unknown");
    expect(mxVerdict(TIMEOUT)).toEqual({ status: "unknown", detail: "ETIMEOUT" });
    expect(mxVerdict({ mx: null, hasA: null, error: "ENOTFOUND" }).status).toBe("unknown");
  });

  test("checkEmails: bad syntax is invalid without a look-up, one look-up per domain, a throwing resolver is unknown", async () => {
    const seen: string[] = [];
    const lookup = async (d: string): Promise<DnsAnswer> => {
      seen.push(d);
      if (d === "dead.example") return NONE;
      if (d === "slow.example") throw new Error("boom");
      return MX;
    };
    const out = await checkEmails(["Pat@Acme.example", "ops@acme.example", "x@dead.example", "y@slow.example", "not-an-email"], lookup);
    expect(out).toEqual([
      { email: "pat@acme.example", status: "domain_ok", detail: "mx" },
      { email: "ops@acme.example", status: "domain_ok", detail: "mx" },
      { email: "x@dead.example", status: "invalid", detail: "no_mx_no_a" },
      { email: "y@slow.example", status: "unknown", detail: "dns" },
      { email: "not-an-email", status: "invalid", detail: "syntax" },
    ]);
    expect(seen.sort()).toEqual(["acme.example", "dead.example", "slow.example"]);
  });

  test("syntax matches public.is_email_address (lower-case, a dot in the domain, 2+ letter TLD)", () => {
    expect(emailSyntaxOk("pat.doe@acme-builders.example")).toBe(true);
    for (const bad of ["Pat@acme.example", "pat@acme", "pat@@acme.example", "a@b.c"]) expect(emailSyntaxOk(bad), bad).toBe(false);
  });
});

describe("pattern guesses (cascade step 2)", () => {
  test("first.last, first, flast, firstlast, f.last from the contact and the site's own domain", () => {
    expect(patternCandidates("José  da Silva Jr.", "acme.example").map((c) => c.email)).toEqual([
      "jose.silva@acme.example", "jose@acme.example", "jsilva@acme.example", "josesilva@acme.example", "j.silva@acme.example",
    ]);
    expect(patternCandidates("Pat", "acme.example")).toEqual([{ email: "pat@acme.example", pattern: "first" }]);
    expect(patternCandidates(null, "acme.example")).toEqual([]);
    expect(patternCandidates("Pat Doe", null)).toEqual([]);
  });
  test("ownDomain: the site's host without www; directories and social pages have none", () => {
    expect(ownDomain("https://www.Acme.example/contact")).toBe("acme.example");
    expect(ownDomain("acme.example")).toBe("acme.example");
    expect(ownDomain("https://www.facebook.com/acme")).toBeNull();
    expect(ownDomain(null)).toBeNull();
  });
});

function item(o: { email?: string | null; website?: string | null; quality?: EmailQuality | null } = {}): LeadListItem {
  const lead = { id: "lead-1", workspace_id: "w", best_candidate_id: null, status: "new", origin_kind: "import", level: 1, first_contacted_at: null } as LeadRow;
  return { lead, best: null, display: { name: "Acme", city: null, phone: null, website: o.website ?? null, email: o.email ?? null }, agentName: null, importName: null, proofOk: 0, emailQuality: o.quality };
}
let fid = 0;
const field = (f: Partial<LeadFieldRow>): LeadFieldRow =>
  ({ id: `f${++fid}`, lead_id: "lead-1", field: "email", value: "", source: "import", source_ref: null, status: "unverified", excerpt: null, seen_at: "2026-11-10T00:00:00Z", ...f }) as LeadFieldRow;

function deps(dns: DnsAnswer, verify?: (e: string) => VerifierStatus, invalid?: Set<string>) {
  const added: GuessRow[] = [];
  const saved: [string, VerifierStatus][] = [];
  return {
    added,
    saved,
    d: {
      lookup: async () => dns,
      verifier: verify ? { name: "fake", verify: async (e: string) => verify(e) } : null,
      addGuesses: async (rows: GuessRow[]) => void added.push(...rows),
      saveVerdict: async (e: string, s: VerifierStatus) => void saved.push([e, s]),
      invalid,
    },
  };
}

describe("e-mail cascade", () => {
  test("step 1: an e-mail on file wins, site-scraped first; a guess never counts as on file", async () => {
    const x = deps(MX);
    const fields = [
      field({ value: "guess@acme.example", source: "pattern" }),
      field({ value: "info@acme.example", source: "import", seen_at: "2026-11-15T00:00:00Z" }),
      field({ value: "Office@Acme.example", source: "apify_contact", seen_at: "2026-11-01T00:00:00Z" }),
    ];
    expect(await findEmailFor(item(), fields, x.d)).toMatchObject({ step: "site", email: "office@acme.example", source: "apify_contact" });
    expect(x.added).toEqual([]);
  });

  test("step 1 never returns an address already checked invalid; the next one on file wins, else the cascade goes on", async () => {
    const fields = [
      field({ value: "office@acme.example", source: "apify_contact" }),
      field({ value: "info@acme.example", source: "import" }),
      field({ field: "contact_name", value: "Pat Doe" }),
      field({ field: "website", value: "acme.example" }),
    ];
    expect(await findEmailFor(item(), fields, deps(MX, undefined, new Set(["office@acme.example"])).d)).toMatchObject({ step: "site", email: "info@acme.example" });
    expect(await findEmailFor(item(), fields, deps(MX, undefined, new Set(["office@acme.example", "info@acme.example"])).d)).toMatchObject({ step: "pattern" });
  });

  test("step 2 with the verifier 'none': guesses are stored as source 'pattern', nothing is verified or saved as a verdict", async () => {
    const x = deps(MX);
    const fields = [field({ field: "contact_name", value: "Pat Doe" }), field({ field: "website", value: "https://www.acme.example" }), field({ value: "pat.doe@acme.example", source: "pattern" })];
    const r = await findEmailFor(item(), fields, x.d);
    expect(r).toMatchObject({ step: "pattern", email: null, reason: null });
    expect(r.guesses[0]).toBe("pat.doe@acme.example");
    // the stored guess is not written again; the rest are, unverified by construction (the DB has no status column here)
    expect(x.added.map((a) => a.email)).toEqual(["pat@acme.example", "pdoe@acme.example", "patdoe@acme.example", "p.doe@acme.example"]);
    expect(x.added[0]).toMatchObject({ leadId: "lead-1", pattern: "first" });
    expect(x.saved).toEqual([]);
  });

  test("step 3: a configured verifier stops at the first 'verified' guess and records every verdict", async () => {
    const x = deps(MX, (e) => (e === "pat@acme.example" ? "verified" : "invalid"));
    const fields = [field({ field: "contact_name", value: "Pat Doe" }), field({ field: "website", value: "acme.example" })];
    expect(await findEmailFor(item(), fields, x.d)).toMatchObject({ step: "verifier", email: "pat@acme.example" });
    expect(x.saved).toEqual([["pat.doe@acme.example", "invalid"], ["pat@acme.example", "verified"]]);
  });

  test("no guesses for a domain that takes no mail, a missing contact or a missing own site", async () => {
    const withSite = [field({ field: "contact_name", value: "Pat Doe" }), field({ field: "website", value: "acme.example" })];
    expect(await findEmailFor(item(), withSite, deps(NONE).d)).toMatchObject({ step: "none", reason: "dead_domain" });
    expect(await findEmailFor(item(), [field({ field: "website", value: "acme.example" })], deps(MX).d)).toMatchObject({ step: "none", reason: "no_contact" });
    expect(await findEmailFor(item({ website: "https://facebook.com/acme" }), [field({ field: "contact_name", value: "Pat" })], deps(MX).d)).toMatchObject({ step: "none", reason: "no_domain" });
  });

  test("EMAIL_VERIFIER: unset, empty, 'none' or an unknown name = no verifier (the step is skipped)", () => {
    expect(emailVerifier(undefined)).toBeNull();
    expect(emailVerifier("none")).toBeNull();
    expect(emailVerifier("somevendor")).toBeNull();
    const fake = { name: "fake", verify: async () => "verified" as const };
    expect(emailVerifier("fake", { fake: () => fake })).toBe(fake);
  });
});

describe("quality badge facet and display", () => {
  const f = DEFAULT_LEAD_FILTERS;
  test("check plan: 'unknown' is retried, fresh mx verdicts and any verifier verdict are skipped, the cap's cut is reported", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    const recent = new Date(now - 3_600_000).toISOString();
    const old = new Date(now - FRESH_MS - 1).toISOString();
    const known = new Map([
      ["fresh@a.example", { status: "domain_ok", method: "mx", checked_at: recent }],
      ["unk@a.example", { status: "unknown", method: "mx", checked_at: recent }],
      ["old@a.example", { status: "invalid", method: "mx", checked_at: old }],
      ["paid@a.example", { status: "unknown", method: "verifier", checked_at: old }],
    ]);
    const emails = ["Fresh@a.example", "unk@a.example", "old@a.example", "paid@a.example", "new1@a.example", "new2@a.example"];
    expect(planEmailCheck(emails, known, now, 3)).toEqual({ todo: ["unk@a.example", "old@a.example", "new1@a.example"], skipped: 2, cut: 1 });
  });

  test("'Qualidade do e-mail' is any-of; an unchecked e-mail matches no quality", () => {
    expect(matchesFacets(item({ email: "a@x.example", quality: "invalid" }), { ...f, emailQuality: ["invalid"] })).toBe(true);
    expect(matchesFacets(item({ email: "a@x.example", quality: "verified" }), { ...f, emailQuality: ["invalid", "catch_all"] })).toBe(false);
    // a domain that takes mail is not a verified mailbox: the two filters never mix
    expect(matchesFacets(item({ email: "a@x.example", quality: "domain_ok" }), { ...f, emailQuality: ["verified"] })).toBe(false);
    expect(matchesFacets(item({ email: "a@x.example", quality: "domain_ok" }), { ...f, emailQuality: ["domain_ok"] })).toBe(true);
    expect(matchesFacets(item({ email: "a@x.example" }), { ...f, emailQuality: ["unknown"] })).toBe(false);
  });
  test("counts per quality, with the quality filter itself left out", () => {
    const items = [item({ quality: "verified" }), item({ quality: "verified" }), item({ quality: "invalid" }), item({})];
    const counts = leadFacetsOf(items, { ...f, emailQuality: ["invalid"] }).emailQuality;
    expect(counts.sort((a, b) => a.value.localeCompare(b.value))).toEqual([{ value: "invalid", n: 1 }, { value: "verified", n: 2 }]);
  });
  test("a guess (source 'pattern') is never the displayed e-mail", () => {
    expect(displayOf(null, [field({ value: "guess@acme.example", source: "pattern", seen_at: "2026-01-01T00:00:00Z" })]).email).toBeNull();
  });
});
