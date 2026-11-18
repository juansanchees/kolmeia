import { describe, expect, test } from "vitest";
import { dedupeCompanies, scoreQueue } from "@/lib/evals/score";
import type { KbItem } from "@/lib/kb/types";
import { ingestLinks, linkItem, permitNoHits, type KbHit } from "../../scripts/pilot-link";

describe("permit-number lookup", () => {
  const hit = (id: string): KbHit => ({ id, name: `Acme ${id}` });
  const q = (ids: string[]) => ({ signalCompanyIds: async () => ids, companies: async (x: string[]) => x.map(hit) });
  test("one company already linked to that permit number = one hit", async () => {
    expect(await permitNoHits(q(["c1", "c1"]), "B-100", "Falmouth")).toEqual([hit("c1")]);
  });
  test("two companies = two hits (the caller keeps it pending); none = none", async () => {
    expect(await permitNoHits(q(["c1", "c2"]), "B-100", "Falmouth")).toHaveLength(2);
    expect(await permitNoHits(q([]), "B-100", "Falmouth")).toEqual([]);
  });
});

describe("link write-back", () => {
  const sig = { kind: "permit" as const, source: "permit" as const, source_ref: "x:B-100", town: "Falmouth", value_usd: "250000", permit_no: "B-100", applicant_name: "Pat Example", applicant_phone: "508-555-0100" };
  const co = { id: "c1", name: "Acme Builders LLC", name_key: "acme builders", domain: "acme.example", phone: "(508) 555-0101", city: "Falmouth" };
  test("re-ingests the signal as match_only with the company's keys and no applicant data", () => {
    const it = linkItem(sig, co);
    expect(it.match_only).toBe(true);
    expect(it.company).toEqual({ name: "Acme Builders LLC", name_key: "acme builders", website: "https://acme.example", phone: "(508) 555-0101", city: "Falmouth" });
    expect(it.signals?.[0]).toMatchObject({ source: "permit", source_ref: "x:B-100", permit_no: "B-100", value_usd: 250000 });
    expect(JSON.stringify(it)).not.toMatch(/Pat Example|555-0100|applicant/);
  });
  test("sends through the fake ingest client in batches of 500", async () => {
    const calls: KbItem[][] = [];
    const items = Array.from({ length: 1001 }, () => linkItem(sig, co));
    expect(await ingestLinks(async (b) => void calls.push(b), items)).toBe(1001);
    expect(calls.map((c) => c.length)).toEqual([500, 500, 1]);
  });
});

describe("one item per company", () => {
  test("dedupeCompanies keeps the best item; metrics count a company once", () => {
    const gold = [{ company: "Acme Builders LLC", tier: "A", temperature: "hot", city: "X", hasFalmouthPermit: true }];
    const raw = [{ company: "Acme Builders", signalRef: "p:1", sourceUrl: "https://example.com/1" }, { company: "ACME BUILDERS LLC", signalRef: "p:2", sourceUrl: "https://example.com/2" }, { company: "Other Co" }];
    const u = dedupeCompanies(raw);
    expect(u.map((x) => x.signalRef)).toEqual(["p:1", undefined]);
    expect(scoreQueue(u, gold).precisionAt[25]).toBe(0.5);
    expect(scoreQueue(raw, gold).duplicates.company).toBe(1);
  });
});
