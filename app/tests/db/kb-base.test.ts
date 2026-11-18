import { describe, expect, it, beforeAll } from "vitest";
import { TestDb, anon, as, service, UUID_A } from "./helpers";
import { KB_SOURCES } from "../../src/lib/kb/sources";

const TABLES = ["kb_companies", "kb_people", "kb_values", "kb_signals", "kb_signal_candidates", "kb_jobs", "kb_lead_links", "kb_source_meta"];

describe("kb_* base tables", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
    await db.addUser(UUID_A);
  });

  it("authenticated cannot read or write kb_*", async () => {
    for (const t of TABLES) {
      expect((await db.try(as(UUID_A), `select * from public.${t}`)).error?.message, t).toMatch(/permission denied/);
    }
    expect((await db.try(as(UUID_A), "insert into public.kb_companies (name, name_key) values ('Acme Builders LLC','acme')")).error?.message).toMatch(/permission denied/);
  });

  it("anon cannot read", async () => {
    for (const t of TABLES) expect((await db.try(anon, `select * from public.${t}`)).error?.message, t).toMatch(/permission denied/);
  });

  it("service_role can insert a company", async () => {
    const r = await db.try(service, "insert into public.kb_companies (name, name_key) values ('Acme Builders LLC','acme') returning id");
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);
  });

  it("RLS is on for every kb_ table", async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname like 'kb\\_%' and relkind = 'r'");
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
  });

  it.each(["apollo", "places", "shovels", "rapidapi_b2b"])("%s source rejected", async (src) => {
    const r = await db.try(service, `insert into public.kb_values (entity, entity_id, field, value, source, seen_at) values ('company', gen_random_uuid(), 'phone', '555-0100', '${src}', now())`);
    expect(r.error?.message).toMatch(/check constraint|violates/);
  });

  it("person phone rejected", async () => {
    const r = await db.try(service, "insert into public.kb_values (entity, entity_id, field, value, source, seen_at) values ('person', gen_random_uuid(), 'phone', '555-0100', 'permit', now())");
    expect(r.error?.message).toMatch(/check constraint|violates/);
  });

  it("kb_people has no phone/email/address column", async () => {
    const rows = await db.admin("select 1 from information_schema.columns where table_name = 'kb_people' and (column_name ~ 'phone|mail|address')");
    expect(rows).toHaveLength(0);
  });

  it("kb_source_meta has one row per KB_SOURCES, and the SQL allowlist accepts exactly those", async () => {
    const rows = await db.admin<{ source: string }>("select source from public.kb_source_meta");
    expect(rows.map((r) => r.source).sort()).toEqual([...KB_SOURCES].sort());
    const bad = await db.try(service, "insert into public.kb_source_meta (source, label) values ('apollo', 'x')");
    expect(bad.error).toBeDefined();
  });

  it("kb_jobs accepts kind pilot and an outcome, rejects an unknown outcome", async () => {
    expect((await db.try(service, "insert into public.kb_jobs (kind, outcome, queried, rows_in, reason) values ('pilot', 'blocked', 3, 0, 'portal blocks robots')")).error).toBeUndefined();
    expect((await db.try(service, "insert into public.kb_jobs (kind, outcome) values ('pilot', 'weird')")).error).toBeDefined();
  });
});
