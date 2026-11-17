import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { CONTACT_ACTOR, contactInput, isDirectoryHost, keepEmails } = await import("@/lib/sources/contact");

const leads = [
  { leadId: "L1", host: "acme-hvac.example.com" },
  { leadId: "L2", host: "bravo.example.org" },
];
const item = (o: Record<string, unknown>) => ({ url: "https://acme-hvac.example.com/contact", originalStartUrl: "https://www.acme-hvac.example.com/", emails: [], phones: [], ...o });

describe("contact scraper (P2b) pure helpers", () => {
  test("keepEmails keeps own-domain and same-site e-mails and drops placeholders and other sites", () => {
    const out = keepEmails(
      [
        item({ emails: ["Info@Acme-HVAC.example.com", "boss@gmail.com", "user@domain.com", "logo@2x.png", "a@example.com", "x@sentry.io", "y@wixpress.com", "z@sentry-next.wixpress.com"] }),
        // another site's page for lead L2: its own e-mail is kept, a stranger's is not
        { url: "https://bravo.example.org/about", originalStartUrl: "https://bravo.example.org", emails: ["hi@bravo.example.org"] },
        // a page of a site that is nobody's lead
        { url: "https://elsewhere.example.net/", originalStartUrl: "https://elsewhere.example.net/", emails: ["x@elsewhere.example.net"] },
      ],
      leads,
    );
    expect(out).toEqual([
      { leadId: "L1", value: "info@acme-hvac.example.com", url: "https://acme-hvac.example.com/contact" },
      { leadId: "L1", value: "boss@gmail.com", url: "https://acme-hvac.example.com/contact" },
      { leadId: "L2", value: "hi@bravo.example.org", url: "https://bravo.example.org/about" },
    ]);
  });

  test("keepEmails ignores phones, social links and every e-mail on a page of another host", () => {
    const out = keepEmails(
      [
        item({ phones: ["+1 508 555 0100"], linkedIns: ["https://www.example-social.test/in/x"], emails: [] }),
        { url: "https://other.example.net/", originalStartUrl: "https://acme-hvac.example.com/", emails: ["a@gmail.com", "own@acme-hvac.example.com"] },
        item({ emails: ["not an email", "", 42, null] }),
      ],
      leads,
    );
    // the redirect page is another host: only the own-domain address survives
    expect(out).toEqual([{ leadId: "L1", value: "own@acme-hvac.example.com", url: "https://other.example.net/" }]);
    expect(keepEmails("nope" as unknown as unknown[], leads)).toEqual([]);
  });

  test("keepEmails drops a web agency's or vendor's address on the lead's own page, keeps a free-mail one, and a lookalike free-mail host", () => {
    const out = keepEmails(
      [item({ emails: ["site-by@webagency.example.net", "rep@manufacturer.example.org", "owner@Gmail.com", "x@gmail.com.example.net", "me@acme-hvac.example.com.evil.example.net", "sales@acme-hvac.example.com"] })],
      leads,
    );
    expect(out.map((o) => o.value)).toEqual(["owner@gmail.com", "sales@acme-hvac.example.com"]);
  });

  test("keepEmails gives every lead that shares one site its e-mails", () => {
    const shared = [{ leadId: "A", host: "acme-hvac.example.com" }, { leadId: "B", host: "www.acme-hvac.example.com" }];
    const out = keepEmails([item({ emails: ["info@acme-hvac.example.com"] })], shared);
    expect(out.map((o) => [o.leadId, o.value])).toEqual([["A", "info@acme-hvac.example.com"], ["B", "info@acme-hvac.example.com"]]);
  });

  test("isDirectoryHost knows social, review and directory sites and the blocked network, not a company's own site", () => {
    for (const h of ["facebook.com", "m.facebook.com", "instagram.com", "yelp.com", "bbb.org", "houzz.com", "angi.com", "thumbtack.com", "sites.google.com", "maps.google.com", "nextdoor.com", "linkedin.com", "uk.linkedin.com", "lnkd.in"]) {
      expect(isDirectoryHost(h), h).toBe(true);
    }
    for (const h of ["acme-hvac.example.com", "googleplumbing.example.com", "yelpers.example.com"]) expect(isDirectoryHost(h), h).toBe(false);
  });

  test("keepEmails keeps at most 3 e-mails per lead, without repeats", () => {
    const e = ["a", "b", "c", "d"].map((x) => `${x}@acme-hvac.example.com`);
    const out = keepEmails([item({ emails: [...e, e[0]] }), item({ emails: [e[3]] })], leads);
    expect(out.map((o) => o.value)).toEqual(e.slice(0, 3));
  });

  test("contactInput fixes maxDepth 1, sameDomain, mergeContacts, Apify proxy", () => {
    expect(CONTACT_ACTOR).toBe("vdrmota~contact-info-scraper");
    expect(contactInput(["https://a.example.com/", "https://b.example.org/"])).toEqual({
      startUrls: [{ url: "https://a.example.com/" }, { url: "https://b.example.org/" }],
      maxRequestsPerStartUrl: 5,
      maxDepth: 1,
      sameDomain: true,
      mergeContacts: true,
      proxyConfig: { useApifyProxy: true },
    });
  });
});

describe("the search history is only for searches", () => {
  test("listRuns asks for Maps, Apollo and Shovels runs only: a contact run is not a search", async () => {
    const { listRuns } = await import("@/lib/sources/queries");
    const seen: unknown[][] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: (...a: unknown[]) => (seen.push(a), q),
      order: () => q,
      limit: async () => ({ data: [], error: null }),
    };
    await listRuns({ from: () => q } as never, "ws");
    expect(seen).toEqual([["kind", ["maps", "apollo", "shovels"]]]);
  });
});
