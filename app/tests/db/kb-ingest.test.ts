import { describe, expect, it, beforeEach } from "vitest";
import { TestDb, as, service, UUID_A } from "./helpers";

const T = "2026-11-01T00:00:00Z";
type Item = Record<string, unknown>;
const co = (name: string, name_key: string, extra: Record<string, unknown> = {}) => ({ name, name_key, ...extra });
const val = (field: string, value: string, source: string, seen_at = T) => ({ field, value, source, seen_at });
const permit = (ref: string, extra: Record<string, unknown> = {}) => ({ kind: "permit", source: "permit", source_ref: ref, address: "12 Example Rd", town: "Exampleton", ...extra });

describe("kb_ingest", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await TestDb.create();
  });
  const ingest = async (items: Item[]) => (await db.query<{ r: Record<string, number> }>(service, "select public.kb_ingest($1::jsonb) as r", [JSON.stringify(items)]))[0].r;
  const count = async (t: string) => Number((await db.admin<{ n: string }>(`select count(*) n from public.${t}`))[0].n);

  it("creates then matches by domain", async () => {
    expect(await ingest([{ company: co("Acme Builders LLC", "acme", { website: "https://www.acmebuild.example.com" }) }])).toMatchObject({ created: 1, matched: 0 });
    expect(await ingest([{ company: co("Totally Other Name", "other", { website: "http://acmebuild.example.com/about" }) }])).toMatchObject({ created: 0, matched: 1 });
    expect(await count("kb_companies")).toBe(1);
  });

  it("matches by phone", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme", { phone: "(508) 555-0100" }) }]);
    expect(await ingest([{ company: co("Zeta Homes", "zeta", { phone: "+1 508-555-0100" }) }])).toMatchObject({ matched: 1 });
    expect(await count("kb_companies")).toBe(1);
  });

  it("same firm, two spellings", async () => {
    await ingest([{ company: co("Acme Builders, Inc", "acme builders", { city: "Exampleton" }), values: [val("phone", "508-555-0101", "maps_robot")] }]);
    await ingest([{ company: co("ACME BUILDERS LLC", "acme builders", { city: "exampleton" }), values: [val("phone", "508-555-0101", "permit")] }]);
    expect(await count("kb_companies")).toBe(1);
    expect((await db.admin<{ source: string }>("select source from public.kb_values order by source")).map((r) => r.source)).toEqual(["maps_robot", "permit"]);
  });

  it("name + city keeps towns apart", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme", { city: "Exampleton" }) }, { company: co("Acme Builders LLC", "acme", { city: "Sampleville" }) }]);
    expect(await count("kb_companies")).toBe(2);
  });

  const twoAcmes = () => ingest([{ company: co("Acme Builders LLC", "acme", { city: "Exampleton" }) }, { company: co("Acme Builders LLC", "acme", { city: "Sampleville" }) }]);

  it("ambiguous name not attached: signal stored as pending with 2 candidates", async () => {
    await twoAcmes();
    const r = await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-1")] }]);
    expect(r).toMatchObject({ created: 0, matched: 0, signals: 1, signals_pending: 1, signals_unlinked: 0 });
    const s = await db.admin<{ company_id: string | null; link_status: string; applicant_name: string }>("select company_id, link_status, applicant_name from public.kb_signals");
    expect(s).toEqual([{ company_id: null, link_status: "pending", applicant_name: "Acme Builders" }]);
    expect(await count("kb_signal_candidates")).toBe(2);
    expect(await count("kb_companies")).toBe(2);
  });

  it("city-less item with shared name_key is idempotent", async () => {
    await twoAcmes();
    const item = [{ company: co("Acme Builders LLC", "acme") }];
    await ingest(item);
    expect(await count("kb_companies")).toBe(3);
    await ingest(item);
    expect(await count("kb_companies")).toBe(3);
  });

  it("permit with blank company kept", async () => {
    const r = await ingest([
      { match_only: true, company: co("", ""), signals: [permit("P-7")] },
      { match_only: true, signals: [permit("P-8")] },
      { company: co("Acme Builders LLC", "acme", { city: "Exampleton" }) },
    ]);
    expect(r).toMatchObject({ created: 1, signals: 2, signals_unlinked: 2 });
    expect(await db.admin("select link_status, company_id from public.kb_signals order by source_ref")).toEqual([
      { link_status: "none", company_id: null }, { link_status: "none", company_id: null },
    ]);
    expect(await count("kb_signal_candidates")).toBe(0);
  });

  it("same name other town goes pending with candidate", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme", { city: "Sampleville" }) }]);
    const r = await ingest([{ match_only: true, company: co("Acme Builders", "acme", { city: "Exampleton" }), signals: [permit("P-3")] }]);
    expect(r).toMatchObject({ signals: 1, signals_pending: 1, matched: 0 });
    expect((await db.admin("select link_status, company_id from public.kb_signals"))[0]).toEqual({ link_status: "pending", company_id: null });
    expect(await db.admin("select reason from public.kb_signal_candidates")).toEqual([{ reason: "same name, other town" }]);
    expect(await count("kb_companies")).toBe(1);
  });

  it("unique name attaches", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme", { city: "Exampleton" }) }]);
    const r = await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-1")] }]);
    expect(r).toMatchObject({ matched: 1, signals: 1, signals_pending: 0, signals_unlinked: 0 });
    expect((await db.admin<{ link_status: string; company_id: string | null }>("select link_status, company_id from public.kb_signals"))[0]).toMatchObject({ link_status: "confirmed" });
  });

  it("permit without company kept", async () => {
    const r = await ingest([{ match_only: true, company: co("Nobody Known Inc", "nobody known"), signals: [permit("P-9", { permit_no: "B-0001" })] }]);
    expect(r).toMatchObject({ created: 0, signals: 1, signals_unlinked: 1 });
    expect((await db.admin("select company_id, link_status, applicant_name, permit_no from public.kb_signals"))[0]).toEqual({ company_id: null, link_status: "none", applicant_name: "Nobody Known Inc", permit_no: "B-0001" });
    expect(await count("kb_companies")).toBe(0);
  });

  it("pending upgraded by later unique match", async () => {
    await twoAcmes();
    await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-1")] }]);
    // a later ingest names the town: unique match by name + city
    const r = await ingest([{ match_only: true, company: co("Acme Builders", "acme", { city: "Sampleville" }), signals: [permit("P-1")] }]);
    expect(r).toMatchObject({ signals: 0, matched: 1 });
    const s = await db.admin<{ link_status: string; company_id: string | null }>("select link_status, company_id from public.kb_signals");
    expect(s[0].link_status).toBe("confirmed");
    expect(s[0].company_id).not.toBeNull();
    expect(await count("kb_signal_candidates")).toBe(0);
  });

  it("none upgraded when the company shows up later", async () => {
    await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-2")] }]);
    await ingest([{ company: co("Acme Builders LLC", "acme", { city: "Exampleton" }) }]);
    await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-2")] }]);
    expect((await db.admin<{ link_status: string }>("select link_status from public.kb_signals"))[0].link_status).toBe("confirmed");
  });

  it("confirmed never downgraded", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme", { city: "Exampleton" }) }]);
    await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-1")] }]);
    await ingest([{ company: co("Acme Builders LLC", "acme", { city: "Sampleville" }) }]); // now the name is ambiguous
    await ingest([{ match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-1")] }]);
    await ingest([{ match_only: true, company: co("Somebody Else", "somebody"), signals: [permit("P-1")] }]);
    const s = await db.admin<{ link_status: string; company_id: string | null }>("select link_status, company_id from public.kb_signals");
    expect(s).toHaveLength(1);
    expect(s[0].link_status).toBe("confirmed");
    expect(s[0].company_id).not.toBeNull();
    expect(await count("kb_signal_candidates")).toBe(0);
  });

  it("second ingest of same permits and maps rows changes no counts", async () => {
    const batch: Item[] = [
      { company: co("Acme Builders LLC", "acme", { city: "Exampleton", phone: "508-555-0102" }), values: [val("phone", "508-555-0102", "maps_robot")], people: [{ name: "Pat Example", name_key: "pat example", title: "Owner", source: "maps_robot", seen_at: T }] },
      { match_only: true, company: co("Acme Builders", "acme"), signals: [permit("P-1")] },
      { match_only: true, company: co("Nobody Known Inc", "nobody"), signals: [permit("P-2")] },
    ];
    await ingest(batch);
    const tables = ["kb_companies", "kb_values", "kb_people", "kb_signals", "kb_signal_candidates"];
    const before = await Promise.all(tables.map(count));
    const r = await ingest(batch);
    expect(await Promise.all(tables.map(count))).toEqual(before);
    expect(r).toMatchObject({ created: 0, values: 0, people: 0, signals: 0 });
  });

  it("retry idempotent: values unchanged, seen_at = newest", async () => {
    const item = (seen: string) => [{ company: co("Acme Builders LLC", "acme"), values: [val("website", "https://acme.example.com", "maps_robot", seen)] }];
    await ingest(item("2026-10-01T00:00:00Z"));
    await ingest(item("2026-11-05T00:00:00Z"));
    await ingest(item("2026-10-15T00:00:00Z"));
    const v = await db.admin<{ seen_at: Date }>("select seen_at from public.kb_values");
    expect(v).toHaveLength(1);
    expect(new Date(v[0].seen_at).toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("fills nulls only", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme", { phone: "508-555-0103", city: "Exampleton" }), values: [val("phone", "508-555-0103", "maps_robot")] }]);
    await ingest([{ company: co("Acme Builders LLC", "acme", { phone: "508-555-0199", city: "Exampleton", zip: "02540" }), values: [val("phone", "508-555-0199", "site_robot")] }]);
    const c = await db.admin<{ phone: string; zip: string }>("select phone, zip from public.kb_companies");
    expect(c).toEqual([{ phone: "508-555-0103", zip: "02540" }]);
    expect(await count("kb_values")).toBe(2);
  });

  it("known company_id skips matching and sets site_read", async () => {
    await ingest([{ company: co("Acme Builders LLC", "acme") }]);
    const id = (await db.admin<{ id: string }>("select id from public.kb_companies"))[0].id;
    await ingest([{ company_id: id, company: co("x", "x"), site_read: { outcome: "ok" } }]);
    expect((await db.admin<{ site_outcome: string; site_read_at: Date }>("select site_outcome, site_read_at from public.kb_companies"))[0].site_outcome).toBe("ok");
    expect(await count("kb_companies")).toBe(1);
  });

  it("rejects unknown keys and bad sources", async () => {
    expect((await db.try(service, "select public.kb_ingest($1::jsonb)", [JSON.stringify([{ company: co("A", "a"), bogus: 1 }])])).error?.message).toMatch(/invalid item/);
    expect((await db.try(service, "select public.kb_ingest($1::jsonb)", [JSON.stringify([{ company: co("A", "a"), values: [val("phone", "1", "apollo")] }])])).error).toBeDefined();
  });

  it("501 items refused", async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ company: co(`Firm ${i}`, `firm ${i}`) }));
    expect((await db.try(service, "select public.kb_ingest($1::jsonb)", [JSON.stringify(items)])).error?.message).toMatch(/too many items/);
  });

  it("authenticated cannot execute", async () => {
    await db.addUser(UUID_A);
    expect((await db.try(as(UUID_A), "select public.kb_ingest('[]'::jsonb)")).error?.message).toMatch(/permission denied/);
  });
});
