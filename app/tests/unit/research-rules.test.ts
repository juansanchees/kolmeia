import { describe, expect, test } from "vitest";
import { sanitizeUrl, hostOf } from "@/lib/safe-url";
import { applyEvidenceRules, approach, normalizeHook, temperature, TEMPERATURE_RULE, type TemperatureInput } from "@/lib/research/rules";
import { dedupe, domainKey, nameKey, phoneKey } from "@/lib/research/dedupe";
import { cleanAnswers, newRunSchema, titleFrom } from "@/lib/research/commands";
import { SYSTEM as QUESTIONS_SYSTEM } from "@/lib/ai/prompts/questions";
import { SYSTEM as PLAN_SYSTEM } from "@/lib/ai/prompts/plan";
import { needsAdvance, limitsFromSources } from "@/lib/research/engine";
import { URL_VECTORS } from "../fixtures/url-vectors";
import { urlKey } from "@/lib/safe-url";
import { controlActionSchema } from "@/lib/research/commands";


const NOW = new Date("2026-11-10T00:00:00Z");
const base: TemperatureInput = {
  hasWork: null,
  existsActive: null,
  biggestJobValueUsd: null,
  lastPermitDate: null,
  website: null,
  reviewCount: null,
  now: NOW,
};

describe("temperature rule [G5]", () => {
  test("very_hot: work + large job", () => {
    expect(temperature({ ...base, hasWork: "ok", biggestJobValueUsd: TEMPERATURE_RULE.largeJobUsd })).toBe("very_hot");
  });
  test("very_hot: work + very recent permit", () => {
    expect(temperature({ ...base, hasWork: "ok", biggestJobValueUsd: 10_000, lastPermitDate: "2026-10-01" })).toBe("very_hot");
  });
  test("hot: work in the period, small and not recent", () => {
    expect(temperature({ ...base, hasWork: "ok", biggestJobValueUsd: 10_000, lastPermitDate: "2026-01-01" })).toBe("hot");
  });
  test("a future or invalid date is not 'recent'", () => {
    expect(temperature({ ...base, hasWork: "ok", lastPermitDate: "2027-01-01" })).toBe("hot");
    expect(temperature({ ...base, hasWork: "ok", lastPermitDate: "nope" })).toBe("hot");
  });
  test("warm: active company without confirmed work, or strong presence", () => {
    expect(temperature({ ...base, existsActive: "ok", hasWork: "unknown" })).toBe("warm");
    expect(temperature({ ...base, website: "https://x.example", reviewCount: 5 })).toBe("warm");
  });
  test("cold: no signal and weak presence; refuted; or business not active", () => {
    expect(temperature({ ...base, website: "https://x.example", reviewCount: 4 })).toBe("cold");
    expect(temperature({ ...base, hasWork: "ok", biggestJobValueUsd: 9e6, refuted: true })).toBe("cold");
    expect(temperature({ ...base, hasWork: "ok", existsActive: "no" })).toBe("cold");
  });
});

describe("approach rule", () => {
  const a = { isLargeContractor: false, supplierPortalUrl: null, phone: "508", publicEmail: null };
  test("large contractor with a portal -> supplier_signup", () => {
    expect(approach({ ...a, isLargeContractor: true, supplierPortalUrl: "https://gc.example/subcontractors" })).toBe("supplier_signup");
  });
  test("large but no valid portal -> call", () => {
    expect(approach({ ...a, isLargeContractor: true, supplierPortalUrl: "javascript:x" })).toBe("call");
  });
  test("no phone but a public email -> email; default call", () => {
    expect(approach({ ...a, phone: null, publicEmail: "a@b.example" })).toBe("email");
    expect(approach(a)).toBe("call");
  });
});

describe("URL sanitising [R11] [R15]", () => {
  test.each([
    ["javascript:alert(1)", null],
    ["data:text/html,x", null],
    ["ftp://x.example", null],
    ["/relative/path", null],
    ["https://www.linkedin.com/in/x", null],
    ["https://br.linkedin.com/company/x", null],
    ["https://LNKD.IN/abc", null],
    ["https://user:pass@site.example", null],
    ["https://exa mple.com", null],
    ["https://localhost/x", null],
    ["https://linkedin.com.evil.example/x", "https://linkedin.com.evil.example/x"],
    ["  https://Site.Example/a?b=1  ", "https://site.example/a?b=1"],
    ["http://site.example", "http://site.example/"],
  ])("%s -> %s", (raw, out) => {
    expect(sanitizeUrl(raw)).toBe(out);
  });
  test("non-strings and huge URLs are rejected", () => {
    expect(sanitizeUrl(42)).toBeNull();
    expect(sanitizeUrl(`https://a.example/${"x".repeat(2100)}`)).toBeNull();
  });
  test("hostOf strips www", () => {
    expect(hostOf("https://www.City.example/x")).toBe("city.example");
    expect(hostOf("mailto:a@b")).toBeNull();
  });
});

describe("evidence rules [P1] [P9]", () => {
  const e = (url: string) => ({ url, title: "t", excerpt: "x" });
  test("[P1] ok without evidence becomes unknown with the reason", () => {
    const r = applyEvidenceRules({ result: "ok", summary: "ativa", evidence: [] }, "careful");
    expect(r.result).toBe("unknown");
    expect(r.summary).toMatch(/Sem fonte/);
  });
  test("[P1] ok whose only evidence is unsafe/LinkedIn becomes unknown", () => {
    const r = applyEvidenceRules({ result: "ok", summary: "", evidence: [e("https://linkedin.com/in/x"), e("javascript:1")] }, "careful");
    expect(r.result).toBe("unknown");
    expect(r.evidence).toEqual([]);
  });
  test("one source is enough below strict", () => {
    expect(applyEvidenceRules({ result: "ok", summary: "", evidence: [e("https://a.example")] }, "careful").result).toBe("ok");
  });
  test("[P9] strict needs two different hosts (www and paths do not count as a second)", () => {
    const same = applyEvidenceRules({ result: "ok", summary: "", evidence: [e("https://a.example/1"), e("https://www.a.example/2")] }, "strict");
    expect(same.result).toBe("unknown");
    expect(same.summary).toMatch(/duas independentes/);
    const two = applyEvidenceRules({ result: "ok", summary: "", evidence: [e("https://a.example/1"), e("https://b.example/2")] }, "strict");
    expect(two.result).toBe("ok");
  });
  test("'no' and 'unknown' keep their result; duplicates dropped; at most 5; text capped", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://h${i}.example`, title: "t".repeat(400), excerpt: "x".repeat(900) }));
    const r = applyEvidenceRules({ result: "no", summary: "s".repeat(900), evidence: [...many, many[0]] }, "strict");
    expect(r.result).toBe("no");
    expect(r.evidence).toHaveLength(5);
    expect(r.evidence[0].title.length).toBeLessThanOrEqual(200);
    expect(r.evidence[0].excerpt.length).toBeLessThanOrEqual(300);
    expect(r.summary.length).toBeLessThanOrEqual(500);
  });
});

describe("hook [G3]", () => {
  test("kept only with confirmed work and when it cites the job address", () => {
    const h = "Saw your permit at 252 Menauhant Rd (~$1.8M) - who's doing the HVAC?";
    expect(normalizeHook(h, "252 Menauhant Rd, Falmouth MA", "ok")).toBe(h);
    expect(normalizeHook(h, "252 Menauhant Rd, Falmouth MA", "unknown")).toBeNull();
    expect(normalizeHook(h, null, "ok")).toBeNull();
    expect(normalizeHook("Who does your HVAC?", "252 Menauhant Rd", "ok")).toBeNull();
  });
});

describe("dedupe [G9]", () => {
  test("keys", () => {
    expect(nameKey("Acme Builders, Inc.")).toBe("acme builders");
    expect(nameKey("ACME BUILDERS LLC")).toBe("acme builders");
    expect(nameKey("Smith & Sons Co.")).toBe("smith and sons");
    expect(phoneKey("+1 (508) 555-0101")).toBe("5085550101");
    expect(phoneKey("555-01")).toBeNull();
    expect(domainKey("https://www.acme.example/about")).toBe("acme.example");
    expect(domainKey("https://www.facebook.com/acme")).toBeNull(); // shared host never identifies a company
  });
  test("same name, same domain or same phone = same company; reports the merged names", () => {
    const existing = [{ name: "Acme Builders", website: "https://acme.example", phone: "508-555-0101" }];
    const { fresh, merged } = dedupe(existing, [
      { name: "ACME BUILDERS INC", website: null, phone: null },
      { name: "Acme Homes", website: "https://www.acme.example/x", phone: null },
      { name: "Other", website: null, phone: "(508) 555-0101" },
      { name: "Beta", website: "https://facebook.com/beta", phone: null },
      { name: "Gamma", website: "https://facebook.com/gamma", phone: null },
      { name: "Beta", website: null, phone: null },
    ]);
    expect(fresh.map((f) => f.name)).toEqual(["Beta", "Gamma"]);
    expect(merged).toEqual(["ACME BUILDERS INC", "Acme Homes", "Other", "Beta"]);
  });
});

describe("commands and state helpers", () => {
  test("answers keep only asked questions and offered options [R15]", () => {
    const run = { questions: [{ id: "size", text: "?", options: ["A", "B"], allowFreeText: false }] };
    expect(cleanAnswers(run, { size: { choices: ["A", "Z"], text: "free" }, other: { choices: ["A"], text: "" } })).toEqual({
      size: { choices: ["A"], text: "" },
    });
  });
  test("title is the request, shortened", () => {
    expect(titleFrom("  a   b ")).toBe("a b");
    expect(titleFrom("x".repeat(200)).length).toBe(80);
  });
  test("needsAdvance", () => {
    expect(needsAdvance({ status: "questions", questions: null, plan: null })).toBe(true);
    expect(needsAdvance({ status: "questions", questions: [], plan: null })).toBe(false);
    expect(needsAdvance({ status: "plan", questions: [], plan: null })).toBe(true);
    expect(needsAdvance({ status: "plan", questions: [], plan: { summary: "", places: [], sourceTypes: [], warnings: [] } })).toBe(false);
    for (const s of ["ready", "running"] as const) expect(needsAdvance({ status: s, questions: [], plan: null })).toBe(true);
    for (const s of ["paused", "done", "failed", "cancelled"] as const) expect(needsAdvance({ status: s, questions: [], plan: null })).toBe(false);
  });
  test("[P10] limits list every blocked, failed and empty source, blocked first", () => {
    const notes = limitsFromSources([
      { title: "A", status: "used", note: "" },
      { title: "B", status: "empty", note: "" },
      { title: "C", status: "blocked", note: "ligar para o Building Division" },
      { title: "D", status: "error", note: "" },
    ]);
    expect(notes.map((n) => n.kind)).toEqual(["blocked", "error", "empty"]);
    expect(notes[0].text).toBe("C: ligar para o Building Division");
  });
});

describe("[P8] no region is refused for lack of a connector", () => {
  test.each(["Anchorage, AK", "ZIP 59701", "Todo o condado de Maricopa, AZ, e 30 milhas de Tucson", "Puerto Rico"])("%s is accepted", (region) => {
    expect(newRunSchema.safeParse({ request: "construtores", region }).success).toBe(true);
  });
  test("prompts say any US place is valid and never to refuse a region", () => {
    expect(QUESTIONS_SYSTEM).toMatch(/Any US place is valid; never refuse a region/);
    expect(PLAN_SYSTEM).toMatch(/Any US place is valid/);
  });
  test("there is no allow-list of places in the code", () => {
    expect(JSON.stringify(newRunSchema.shape.region)).not.toMatch(/Boston|Worcester/);
  });
});

// ---------------------------------------------------------------- review of 10/11/2026

describe("[finding 10] URL rules (same vectors as the SQL test in tests/db/hardening.test.ts)", () => {
  test.each(URL_VECTORS)("%s -> safe %s, host %s", (url, safe, host) => {
    expect(sanitizeUrl(url) !== null).toBe(safe);
    expect(hostOf(url)).toBe(host);
  });
  test("urlKey: same page across www, http/https, default port and click-tracking params (real search vs citation pairs)", () => {
    // Pairs seen in the Falmouth run of 10/11/2026: the search returned one form, the model cited another.
    expect(urlKey("https://falmouthma.gov/Faq.aspx?QID=133")).toBe(urlKey("https://www.falmouthma.gov/Faq.aspx?QID=133"));
    expect(urlKey("https://www.johnlopesandsons.com/")).toBe(urlKey("http://johnlopesandsons.com"));
    expect(urlKey("https://hamblinhomes.com/?utm_source=google&utm_medium=cpc")).toBe(urlKey("https://hamblinhomes.com/"));
    expect(urlKey("https://www.houzz.com/pro/x?srsltid=AfmBOo&page=2")).toBe("https://houzz.com/pro/x?page=2");
    expect(urlKey("https://acme.example:443/a")).toBe("https://acme.example/a");
    // Path case and real parameters still matter: a different page is a different page.
    expect(urlKey("https://falmouthma.gov/Faq.aspx")).not.toBe(urlKey("https://falmouthma.gov/faq.aspx"));
    expect(urlKey("https://acme.example/a?id=1")).not.toBe(urlKey("https://acme.example/a?id=2"));
  });

  test("urlKey: scheme/host case, trailing slash and fragment do not matter; query does", () => {
    expect(urlKey("HTTPS://Acme.Example./About/#team")).toBe("https://acme.example/About");
    expect(urlKey("https://acme.example/a?b=1")).not.toBe(urlKey("https://acme.example/a?b=2"));
    expect(urlKey("javascript:alert(1)")).toBeNull();
  });
});

describe("[finding 12] dedupe says what each merged name was merged into", () => {
  test("by name, domain and phone", () => {
    const out = dedupe(
      [{ name: "Acme Builders, Inc.", website: "https://acme.example", phone: "508-555-0101" }],
      [
        { name: "ACME BUILDERS", website: null, phone: null },
        { name: "Other Name", website: "https://www.acme.example/x", phone: null },
        { name: "Third", website: null, phone: "+1 (508) 555-0101" },
        { name: "New Co", website: null, phone: null },
      ],
    );
    expect(out.fresh.map((c) => c.name)).toEqual(["New Co"]);
    expect(out.mergedInto).toEqual([
      { name: "ACME BUILDERS", into: "Acme Builders, Inc." },
      { name: "Other Name", into: "Acme Builders, Inc." },
      { name: "Third", into: "Acme Builders, Inc." },
    ]);
  });
});

describe("[finding 13] run controls accept only pause, resume and cancel", () => {
  test("unknown actions are refused instead of cancelling", () => {
    expect(controlActionSchema.safeParse("cancel").success).toBe(true);
    for (const bad of ["stop", "", "CANCEL", "delete", null]) expect(controlActionSchema.safeParse(bad).success).toBe(false);
  });
  test("the server action validates before touching the run", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/app/(app)/agentes/actions.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function controlResearch"));
    expect(body.indexOf("controlActionSchema.safeParse(action)")).toBeGreaterThan(-1);
    expect(body.indexOf("controlActionSchema.safeParse(action)")).toBeLessThan(body.indexOf("loadRun("));
  });
});

describe("[finding 17] limits list 'found, not opened' sources after the refused and empty ones", () => {
  test("order and text", () => {
    const notes = limitsFromSources([
      { title: "A", status: "unverified", note: "" },
      { title: "B", status: "blocked", note: "ligar" },
      { title: "C", status: "used", note: "" },
    ]);
    expect(notes.map((n) => n.kind)).toEqual(["blocked", "unverified"]);
    expect(notes[1].text).toMatch(/não aberta/);
  });
});
