import { describe, expect, test } from "vitest";
import { b2bParams, mapDecisionMaker, quotaLeft, rapidApiClient, RapidApiError, siteEmails } from "@/lib/sources/rapidapi";
import { parseB2bForm, runTitle, todayLine } from "@/lib/sources/view";
import { sourceLabel } from "@/lib/spend/view";
import { fakeHttp } from "./sources-fakes";

// RapidAPI adapter: fictional people and companies only, no network. The key below is a made-up test value.
const KEY = "rapidapi_TESTKEY_000000000000";
const B2B = "https://b2b-lead-finder-for-cold-email.p.rapidapi.com/coldEmailFinder";
const SITE = "https://website-contact-finder.p.rapidapi.com/";

const person = (o: Record<string, unknown> = {}) => ({
  Name: "Pat Example",
  "First Name": "Pat",
  "Last Name": "Example",
  Email: "pat@granite-ridge.example",
  "Email Domain": "granite-ridge.example",
  "Job Title": "Founder & President",
  Seniority: "founder",
  City: "Worcester",
  State: "Massachusetts",
  Country: "United States",
  LinkedIn: "https://www.linkedin.com/in/pat-example",
  "Company Name": "Granite Ridge Builders",
  "Company Location": "Worcester, Massachusetts, United States",
  "Company LinkedIn": "https://www.linkedin.com/company/granite-ridge",
  "Company Size": 30,
  "Company Industry": "Building_Construction",
  "Company Domain": "granite-ridge.example",
  ...o,
});

describe("mapDecisionMaker", () => {
  test("maps the company as the lead and the person as its contact; profile links are never read", () => {
    const r = mapDecisionMaker(person(), "MA", 4);
    expect(r).toEqual({
      row: 4,
      name: "Granite Ridge Builders",
      name_key: expect.any(String),
      website: "https://granite-ridge.example/",
      city: "Worcester",
      state: "MA",
      contact_name: "Pat Example",
      contact_title: "Founder & President",
      email: "pat@granite-ridge.example",
      company_type: "Building Construction",
    });
    expect(JSON.stringify(r)).not.toMatch(/linkedin/i);
  });

  test("only the United States, and only the chosen state when the location says one", () => {
    expect(mapDecisionMaker(person({ Country: "Canada" }), "MA")).toBeNull();
    expect(mapDecisionMaker(person({ Country: undefined }), "MA")).toBeNull();
    expect(mapDecisionMaker(person({ "Company Location": "Austin, Texas, United States" }), "MA")).toBeNull();
    expect(mapDecisionMaker(person({ "Company Location": "Worcester, Massachusetts, United States" }), "NH")).toBeNull();
    // no company location: the person's own state decides; none at all: kept
    expect(mapDecisionMaker(person({ "Company Location": undefined, State: "Texas" }), "MA")).toBeNull();
    expect(mapDecisionMaker(person({ "Company Location": undefined, State: "MA" }), "MA")?.city).toBe("Worcester");
    expect(mapDecisionMaker(person({ "Company Location": undefined, State: undefined }), "MA")).not.toBeNull();
    expect(mapDecisionMaker(person({ "Company Location": "Concord, New Hampshire, United States" }), "NH")?.state).toBe("NH");
  });

  test("bad values drop the field, never the row; no company name drops the row; caps by length", () => {
    expect(mapDecisionMaker(person({ "Company Name": "  " }), "MA")).toBeNull();
    expect(mapDecisionMaker(null, "MA")).toBeNull();
    const r = mapDecisionMaker(person({ Email: "not-an-email", "Job Title": 7, "Company Domain": "javascript:alert(1)", Name: "x".repeat(400) }), "MA");
    expect(r?.email).toBeUndefined();
    expect(r?.contact_title).toBeUndefined();
    expect(r?.website).toBeUndefined();
    expect(r?.contact_name).toHaveLength(300);
    expect(mapDecisionMaker(person({ "Company Name": "N".repeat(250) }), "MA")?.name).toHaveLength(200);
    for (const bad of ["127.0.0.1", "linkedin.com", "user:pw@x.example", "localhost"]) {
      expect(mapDecisionMaker(person({ "Company Domain": bad }), "MA")?.website, bad).toBeUndefined();
    }
    expect(mapDecisionMaker(person({ "Company Domain": "https://www.granite-ridge.example/about" }), "MA")?.website).toBe("https://www.granite-ridge.example/");
  });
});

describe("siteEmails", () => {
  const answer = (emails: unknown[], sources: unknown[] = []) => ({ data: { error: null, domain: "granite-ridge.example", contact: { emails, phones: ["5085550101"] }, sources: { emails: sources } } });

  test("own-domain e-mails with the page as proof; the contact's own mailbox first, generic ones last; at most 3", () => {
    const json = answer(["info@granite-ridge.example"], [
      { value: "info@granite-ridge.example", occurrences: 9, best_source: "https://www.granite-ridge.example/contact" },
      { value: "pexample@granite-ridge.example", occurrences: 1, best_source: "https://www.granite-ridge.example/about/our-team" },
      { value: "sam.lee@granite-ridge.example", occurrences: 2, best_source: "https://www.granite-ridge.example/team" },
      { value: "office@granite-ridge.example", occurrences: 3, best_source: "https://www.granite-ridge.example/" },
    ]);
    expect(siteEmails(json, "https://www.granite-ridge.example/", "Pat Example")).toEqual([
      { value: "pexample@granite-ridge.example", url: "https://www.granite-ridge.example/about/our-team" },
      { value: "sam.lee@granite-ridge.example", url: "https://www.granite-ridge.example/team" },
      { value: "info@granite-ridge.example", url: "https://www.granite-ridge.example/contact" },
    ]);
  });

  test("drops other companies' and junk addresses; a third-party page is not proof; a bad answer or site gives nothing", () => {
    const json = answer(["owner.gr@gmail.com", "someone@agency.example"], [
      { value: "webdesign@agency.example", best_source: "https://www.granite-ridge.example/" },
      { value: "pat@granite-ridge.example", best_source: "https://directory.example/listing" },
      { value: "logo@2x.png", best_source: "https://www.granite-ridge.example/" },
    ]);
    // a free-mail address with no page behind it (contact.emails) is not proof either
    expect(siteEmails(json, "https://granite-ridge.example", null)).toEqual([{ value: "pat@granite-ridge.example", url: "https://granite-ridge.example/" }]);
    expect(siteEmails({ data: "x" }, "https://granite-ridge.example")).toEqual([]);
    expect(siteEmails(answer(["pat@granite-ridge.example"]), "javascript:alert(1)")).toEqual([]);
  });
});

describe("rapidApiClient", () => {
  test("B2B: the key travels only in the header; presets become the API's values; 401 = key, 429 = plan limit", async () => {
    const h = fakeHttp({ [`GET ${B2B}`]: { status: 200, json: { ok: true, leads: [person()], summary: { totalLeads: 1 } } } });
    const items = await rapidApiClient(KEY, h).decisionMakers({ state: "NH", sector: "construction", size: "11-50", role: "founder" }, 3);
    expect(items).toHaveLength(1);
    const q = new URL(h.calls[0].url).searchParams;
    expect(Object.fromEntries(q)).toEqual({
      companyLocation: "New_Hampshire",
      companyIndustries: "Building_Construction",
      companySize: "11-50",
      contactSeniority: "founder",
      pageNumber: "3",
    });
    expect(h.calls[0].headers).toMatchObject({ "X-RapidAPI-Key": KEY, "X-RapidAPI-Host": "b2b-lead-finder-for-cold-email.p.rapidapi.com" });
    expect(h.calls[0].url).not.toContain(KEY);
    for (const [status, code] of [[401, "key"], [403, "key"], [429, "http_429"], [500, "http_500"]] as const) {
      const e = await rapidApiClient(KEY, fakeHttp({ [`GET ${B2B}`]: { status, json: { message: KEY } } })).decisionMakers({ state: "MA", sector: "architecture", size: "1-10", role: "manager" }, 1).catch((x) => x);
      expect(e).toBeInstanceOf(RapidApiError);
      expect(e.code).toBe(code);
      expect(String(e.message)).not.toContain(KEY);
    }
    await expect(rapidApiClient(KEY, fakeHttp({ [`GET ${B2B}`]: { status: 200, json: { ok: false } } })).decisionMakers({ state: "MA", sector: "architecture", size: "1-10", role: "manager" }, 1)).rejects.toMatchObject({ code: "bad_response" });
    // a filter the API did not take: the run fails, nothing is imported
    const bad = fakeHttp({ [`GET ${B2B}`]: { status: 200, json: { ok: true, leads: [person()], summary: { invalidInputs: { companyIndustries: "x" } } } } });
    await expect(rapidApiClient(KEY, bad).decisionMakers({ state: "MA", sector: "construction", size: "11-50", role: "founder" }, 1)).rejects.toMatchObject({ code: "bad_query" });
    const ok = fakeHttp({ [`GET ${B2B}`]: { status: 200, json: { ok: true, leads: [person()], summary: { invalidInputs: {} } } } });
    expect(await rapidApiClient(KEY, ok).decisionMakers({ state: "MA", sector: "construction", size: "11-50", role: "founder" }, 1)).toHaveLength(1);
    expect(b2bParams({ state: "MA", sector: "real_estate", size: "51-200", role: "c-suite" }, 0).get("companyIndustries")).toBe("Property_Management,Real_Estate_Investment_and_Development,Other_-_Real_Estate");
  });

  test("site reader: asks for contacts and sources only; reads what the plan says is left", async () => {
    const h = fakeHttp({ [`GET ${SITE}`]: { status: 200, json: { data: {} }, headers: { "x-ratelimit-credits-remaining": "7", "x-ratelimit-requests-remaining": "40" } } });
    const r = await rapidApiClient(KEY, h).siteContacts("https://granite-ridge.example/");
    expect(r.left).toBe(7);
    expect(Object.fromEntries(new URL(h.calls[0].url).searchParams)).toEqual({ url: "https://granite-ridge.example/", contact: "true", sources: "true", profile: "false", visuals: "false", meta: "false" });
    expect(quotaLeft({ "x-ratelimit-credits-remaining": "0" })).toBe(0);
    expect(quotaLeft({})).toBeNull();
    expect(quotaLeft({ "x-ratelimit-credits-remaining": "lots" })).toBeNull();
    expect(quotaLeft(undefined)).toBeNull();
  });
});

describe("B2B form and labels", () => {
  test("parseB2bForm takes only the presets; page is never taken from the form", () => {
    expect(parseB2bForm({ state: "MA", sector: "construction", size: "11-50", role: "founder", label: " " })).toEqual({
      ok: true,
      value: { query: { state: "MA", sector: "construction", size: "11-50", role: "founder" }, max: 100 },
    });
    expect(parseB2bForm({ state: "MA", sector: "construction", size: "11-50", role: "founder", label: "GCs" }).ok).toBe(true);
    for (const bad of [{ state: "TX" }, { sector: "retail" }, { size: "501-1_000" }, { role: "intern" }, { label: "x".repeat(61) }]) {
      expect(parseB2bForm({ state: "MA", sector: "construction", size: "11-50", role: "founder", ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  test("run title, month lines and spend rows", () => {
    expect(runTitle({ kind: "b2b", query: { state: "MA", sector: "construction", page: 2 } })).toBe("Construção · MA · página 2");
    expect(todayLine({ provider: "rapidapi", today: 3, cap: 10 })).toBe("3 de 10 buscas de decisores este mês");
    expect(todayLine({ provider: "rapidapi_sites", today: null, cap: 30 })).toBe("? de 30 sites lidos este mês");
    expect(sourceLabel("rapidapi", "b2b")).toBe("RapidAPI decisores");
    expect(sourceLabel("rapidapi", "contact")).toBe("RapidAPI e-mails do site");
    expect(sourceLabel("apify", "contact")).toBe("Apify contatos");
  });
});
