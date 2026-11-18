import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { interpretInstruction } from "@/lib/hunt/interpret";
import { word } from "@/lib/hunt/text";
import { OFFERS } from "@/lib/offers";
import { en } from "@/messages/en";
import { pt } from "@/messages/pt";

// Every code the hunt modules emit has a message in both languages (no screen shows a raw code).
const src = (f: string) => readFileSync(new URL(`../../src/lib/${f}`, import.meta.url), "utf8");
const strings = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);

// Codes read from the offer sources, so a new code without words fails here.
const hvac = src("offers/hvac-new-construction.ts");
const PRIORITY = [...strings(hvac, /add\(-?\d+, "(\w+)"\)/g), ...["new_build", "recent", "hvac_fit"].map((k) => `fails_${k}`), "not_implemented"];
const QUESTIONS = [...strings(hvac, /q\.push\("(\w+)"\)/g), "hvac_by_other_trade"];
// Literal codes from the source, plus the per-kind pair built as `prefer_${kind}` / `deprioritize_${kind}`.
const UNDERSTOOD = [...strings(src("hunt/interpret.ts"), /code\("(\w+)"\)/g), ...["multifamily", "commercial", "single_family"].flatMap((k) => [`prefer_${k}`, `deprioritize_${k}`])];

describe.each([["pt", pt], ["en", en]] as const)("hunt messages (%s)", (_l, M) => {
  const H = M.hunt;
  test("priority, question and understood codes have words", () => {
    expect(PRIORITY.length).toBeGreaterThanOrEqual(15);
    for (const c of PRIORITY) expect(H.priority, c).toHaveProperty(c);
    for (const c of QUESTIONS) expect(H.questions, c).toHaveProperty(c);
    expect(UNDERSTOOD.length).toBeGreaterThanOrEqual(11);
    for (const c of UNDERSTOOD) expect(H.understood, c).toHaveProperty(c);
    for (const c of ["new_construction_scope"]) expect(H.understood).toHaveProperty(c);
  });
  test("every code of every offer proposal has words", () => {
    for (const o of Object.values(OFFERS)) {
      expect(H.proposals.titles).toHaveProperty(`search_${o.id}`);
      for (const c of o.meta.buyerCodes) expect(H.proposals.buyers, c).toHaveProperty(c);
      for (const c of o.meta.signalCodes) expect(H.proposals.signals, c).toHaveProperty(c);
      for (const c of o.meta.sourceCodes) expect(H.proposals.sources, c).toHaveProperty(c);
      for (const p of [{ what_we_do: "HVAC", wanted_work: ["new_construction", "multifamily", "commercial", "maintenance"] }, { what_we_do: "HVAC", not_wanted: "new construction" }, { what_we_do: "HVAC" }]) {
        const f = o.meta.profileFit(p);
        for (const c of f.reasonCodes) expect(H.proposals.whyFit, c).toHaveProperty(c);
        for (const c of f.assumptionCodes) expect(H.proposals.assumptions, c).toHaveProperty(c);
        if (f.missing) expect(H.proposals.questions, f.missing).toHaveProperty(f.missing);
      }
    }
    for (const c of ["best_profile_fit", "only_fit", "coverage_ok", "coverage_blocked", "coverage_unknown"]) expect(H.proposals.reasons, c).toHaveProperty(c);
  });
  test("round words: stop reasons, coverage outcomes, blockers and asks the app emits, building kinds, sources", () => {
    for (const c of ["fulfilled", "limit", "exhausted", "waiting"]) expect(H.round.stop, c).toHaveProperty(c);
    for (const c of ["ok", "partial", "blocked", "robots", "down", "login", "empty", "skipped"]) expect(H.round.outcomes, c).toHaveProperty(c);
    for (const c of strings(src("hunt/flow.ts"), /code: "(need_\w+)"/g)) expect(H.round.blockerCodes, c).toHaveProperty(c);
    for (const c of strings(src("hunt/flow.ts"), /code: "(run_\w+)", ask: true/g)) expect(H.round.askCodes, c).toHaveProperty(c);
    for (const c of ["single_family", "adu", "multifamily", "commercial", "other"]) expect(H.pref.kinds, c).toHaveProperty(c);
    for (const c of ["maps_robot", "permit", "project", "crosswalk", "license_csl", "license_hic", "corp_registry", "site_robot"]) expect(H.cov.sources, c).toHaveProperty(c);
  });
  test("an unknown code falls back to the code, never blank", () => expect(word(H.priority, "brand_new_code")).toBe("brand_new_code"));
  test("the acceptance sentence is understood in pt and the english twin in en", () => {
    const codes = interpretInstruction(_l === "pt" ? "essas casas são pequenas demais; priorize multifamiliares e descubra por onde apresentar orçamento" : "these houses are too small; prioritize multifamily and find where to submit a bid", _l).understoodCodes;
    for (const c of codes) expect(H.understood, c).toHaveProperty(c);
    expect(codes).toContain("want_bid_path");
  });
});
