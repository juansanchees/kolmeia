import { describe, expect, test } from "vitest";
import { goldFromCsv, type GoldRow } from "@/lib/evals/gold";
import { anonymize, compareRounds, missingWhy, scoreQueue, type QueueItem } from "@/lib/evals/score";

const g = (company: string, o: Partial<GoldRow> = {}): GoldRow => ({ company, tier: "A", temperature: "hot", city: "Townville", hasFalmouthPermit: false, ...o });
const GOLD = [
  g("Acme Builders LLC", { phone: "(508) 555-0101", hasFalmouthPermit: true }),
  g("Bay Example Homes", { website: "https://www.bay.example/", tier: "B" }),
  g("Cape Sample Corp", { phone: "508-555-0103" }),
];
const q = (company: string, o: Partial<QueueItem> = {}): QueueItem => ({ company, ...o });

describe("scoreQueue", () => {
  test("recovered and missed by name, domain and phone", () => {
    const s = scoreQueue([q("ACME BUILDERS, Inc."), q("Other Name", { website: "https://bay.example/about" }), q("Zzz", { phone: "+1 508 555 0199" })], GOLD);
    expect(s.denominators).toEqual({ queue: 3, gold: 3, goldByTier: { A: 2, B: 1 }, goldWithPermit: 1 });
    expect(s.recovered.count).toBe(2);
    expect(s.recovered.byTier).toEqual({ A: 1, B: 1 });
    expect(s.recovered.withPermit).toBe(1);
    expect(s.missed).toMatchObject({ count: 1, goldIdx: [2] });
    expect(s.inGoldIdx).toEqual([0, 1]);
  });
  test("duplicates: same company twice and same signal twice", () => {
    const s = scoreQueue([q("Acme Builders", { signalRef: "p:1" }), q("ACME BUILDERS LLC", { signalRef: "p:2" }), q("Dune Example", { signalRef: "p:2" })], GOLD);
    expect(s.duplicates).toEqual({ company: 1, signal: 1 });
  });
  test("proof, contact path and the not-in-gold split", () => {
    const s = scoreQueue([q("Acme Builders", { sourceUrl: "https://example.com/a", contactPath: "phone" }), q("New One", { sourceUrl: "https://example.com/b", contactPath: "bids" }), q("No Proof Co", { contactPath: "none" })], GOLD);
    expect(s.withProof).toBe(2);
    expect(s.withContactPath).toBe(2);
    expect(s.notInGold).toBe(2);
    expect(s.newNotInGold).toEqual([1]);
    expect(s.falsePositives).toBe(1);
  });
  test("top-N precision uses the first N only", () => {
    const queue = [q("Acme Builders"), q("Nope One"), q("Bay Example Homes"), q("Nope Two")];
    expect(scoreQueue(queue, GOLD, [2, 4]).precisionAt).toEqual({ 2: 0.5, 4: 0.5 });
    expect(scoreQueue([], GOLD).precisionAt[25]).toBe(0);
  });
  test("empty gold never divides by zero", () => {
    expect(scoreQueue([q("Acme")], []).recovered.count).toBe(0);
  });
});

describe("compareRounds", () => {
  test("up, down, same, new and dropped", () => {
    const a = [{ key: "a", priority: 10 }, { key: "b", priority: 50 }, { key: "c", priority: 30 }, { key: "d", priority: 5 }];
    const b = [{ key: "a", priority: 20 }, { key: "b", priority: 40 }, { key: "c", priority: 30 }, { key: "e", priority: 9 }];
    expect(compareRounds(a, b)).toEqual({ up: 1, down: 1, same: 1, new: 1, dropped: 1 });
  });
});

describe("anonymize", () => {
  test("initials and town only: no full name, phone or address", () => {
    const out = anonymize("Acme Builders LLC", "Falmouth");
    expect(out).toBe("A.B.L. (Falmouth)");
    expect(out).not.toMatch(/Acme|Builders|\d/);
    expect(anonymize("12 Example Rd Co", "Town 508-555-0100")).not.toMatch(/\d/);
    expect(anonymize("", "")).toBe("? (?)");
  });
});

describe("goldFromCsv", () => {
  test("reads columns by header name and drops rows without a company", () => {
    const rows = goldFromCsv("company,tier,temperature,city,phone,website,has_falmouth_permit\nAcme Builders LLC,A,hot,Townville,555-0101,,1\n,B,cold,Townville,,,0\n");
    expect(rows).toEqual([{ company: "Acme Builders LLC", tier: "A", temperature: "hot", city: "Townville", phone: "555-0101", hasFalmouthPermit: true }]);
  });
});

describe("missingWhy", () => {
  test("says what the round file shows: no work signal, work without a builder, or work not in the queue", () => {
    expect(missingWhy(q("Acme Builders LLC"), new Set())).toBe("no_work_signal");
    expect(missingWhy(q("Acme Builders LLC", { signalRef: "project:1" }), new Set(["project:1"]))).toBe("work_unlinked");
    expect(missingWhy(q("Acme Builders LLC", { signalRef: "project:2" }), new Set(["project:1"]))).toBe("work_not_in_queue");
  });
});
