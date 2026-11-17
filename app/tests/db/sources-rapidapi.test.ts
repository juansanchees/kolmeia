import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS_DIR, TestDb, as, setSchedulerToken } from "./helpers";
import { TOKEN } from "./scheduler-seed";
import { clock } from "./hunter-seed";
import { beginQualifierTick, qclock } from "./qualifier-seed";
import { SOURCE_CIPHER, seedSources } from "./sources-seed";
import { row } from "./lists-seed";

// Migration 0034: RapidAPI (B2B decision-makers + e-mails from a company's own site). Fictional data only.

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
beforeEach(async () => {
  await db.admin("update public.source_ticks set finished_at = now() where finished_at is null");
  await db.admin("update public.qualifier_ticks set finished_at = now() where finished_at is null");
  // other tests' queued runs would take the 3 start slots first
  await db.admin("update public.source_runs set status = 'refused', error = 'test' where status = 'queued'");
});
afterAll(async () => {
  await db.pg.close();
});

const code = (e: unknown) => (e as { code?: string }).code;
const Q = { state: "MA", sector: "construction", size: "11-50", role: "founder" };
const enqueue = (u: string, ws: string, query: unknown = Q) =>
  db.try<{ id: string }>(as(u), "select public.enqueue_source_run($1,'b2b',$2::jsonb,100) as id", [ws, JSON.stringify(query)]);
const add = async (u: string, ws: string, query: unknown = Q) =>
  (await db.query<{ id: string }>(as(u), "select public.enqueue_source_run($1,'b2b',$2::jsonb,100) as id", [ws, JSON.stringify(query)]))[0].id;
const use = async (u: string, ws: string) =>
  (await db.query<{ monthly_records: number; used_month: number; monthly_sites: number; used_sites: number }>(
    as(u),
    "select monthly_records, used_month, monthly_sites, used_sites from public.list_source_connections($1) where provider = 'rapidapi'",
    [ws],
  ))[0];
const addLead = async (ws: string) => (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]))[0].id;
const askSite = (u: string, ws: string, lead: string, url = "https://acme-build.example.com/") =>
  db.query<{ r: boolean }>(as(u), "select public.request_site_contact($1,$2,$3) as r", [ws, lead, url]).then((x) => x[0].r);
const sourceTick = async () => (await db.query<{ r: { tick_id: string } }>(clock, "select public.source_begin_tick() as r"))[0].r.tick_id;

async function connected(cap: number | null = null) {
  const s = await seedSources(db);
  await db.query(as(s.owner), "select public.set_source_connection($1,'rapidapi',$2,'RA12',$3)", [s.ws, SOURCE_CIPHER, cap]);
  return s;
}

describe("0034 rapidapi source", () => {
  test("'rapidapi' is accepted; an unknown provider is still refused; two caps with their own ranges", async () => {
    const { ws, owner, sdr } = await connected();
    expect(await use(owner, ws)).toEqual({ monthly_records: 10, used_month: 0, monthly_sites: 30, used_sites: 0 });
    expect((await db.query(as(sdr), "select provider from public.list_source_connections($1)", [ws])).map((r) => r.provider)).toEqual(["apify", "apollo", "rapidapi"]);
    expect(code((await db.try(as(owner), "select public.set_source_connection($1,'serpapi',$2,'AB12',null)", [ws, SOURCE_CIPHER])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'serpapi',10)", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.enqueue_source_run($1,'serpapi','{}'::jsonb,10)", [ws])).error)).toBe("22023");
    await expect(db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results) values ($1,'rapidapi','maps',1)", [ws])).rejects.toMatchObject({ code: "23514" });
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'rapidapi',0)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'rapidapi',5001)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'rapidapi_sites',50001)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'rapidapi_sites',2.5)", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(sdr), "select public.set_source_cap($1,'rapidapi',20)", [ws])).error)).toBe("42501");
    await db.query(as(owner), "select public.set_source_cap($1,'rapidapi',25)", [ws]);
    await db.query(as(owner), "select public.set_source_cap($1,'rapidapi_sites',300)", [ws]);
    // each cap leaves the other alone; a new key keeps both
    await db.query(as(owner), "select public.set_source_connection($1,'rapidapi',$2,'RA34',null)", [ws, SOURCE_CIPHER]);
    expect(await use(owner, ws)).toMatchObject({ monthly_records: 25, monthly_sites: 300 });
    await expect(db.admin("update public.source_connections set monthly_sites = 5 where workspace_id = $1 and provider = 'apollo'", [ws])).rejects.toMatchObject({ code: "23514" });
  });

  test("b2b enqueue validates presets, sets the page itself and stops at the monthly call cap", async () => {
    const { ws, owner } = await connected(2);
    for (const q of [{ ...Q, state: "TX" }, { ...Q, sector: "retail" }, { ...Q, size: "501-1_000" }, { ...Q, role: "intern" }, { ...Q, page: 3 }, { state: "MA" }]) {
      expect(code((await enqueue(owner, ws, q)).error), JSON.stringify(q)).toBe("22023");
    }
    const a = await add(owner, ws);
    const r = (await db.admin<{ provider: string; max_results: number; query: { page: number } }>("select provider, max_results, query from public.source_runs where id = $1", [a]))[0];
    expect(r).toMatchObject({ provider: "rapidapi", max_results: 100, query: { page: 1 } });
    // an imported page with results moves the next run of the same filters to page 2
    await db.admin("update public.source_runs set status = 'imported', found = 88 where id = $1", [a]);
    const b = await add(owner, ws);
    expect((await db.admin<{ p: number }>("select (query->>'page')::int as p from public.source_runs where id = $1", [b]))[0].p).toBe(2);
    expect((await use(owner, ws)).used_month).toBe(2);
    expect((await enqueue(owner, ws)).error?.message).toBe("source_cap");
  });

  test("tick path: b2b import makes a 'Decisores: Construção MA (dd/mm)' list of kind rapidapi_b2b", async () => {
    const { ws, owner } = await connected();
    const id = await add(owner, ws);
    const t = await sourceTick();
    const work = (await db.query<{ r: { start: { id: string; provider: string; kind: string }[] } }>(clock, "select public.source_next_work($1) as r", [t]))[0].r;
    expect(work.start.find((s) => s.id === id)).toMatchObject({ provider: "rapidapi", kind: "b2b" });
    await db.query(clock, "select public.source_mark_started($1,$2,'rapidapi','')", [t, id]);
    const rows = [row(1, "Granite Ridge Builders", { contact_name: "Pat Example", contact_title: "Founder", website: "https://granite-ridge.example" })];
    await db.query(clock, "select public.source_import($1,$2,$3::jsonb,12,11,0)", [t, id, JSON.stringify(rows)]);
    const run = (await db.admin<{ import_id: string }>("select import_id from public.source_runs where id = $1", [id]))[0];
    const im = (await db.admin<{ kind: string; list_name: string }>("select kind, list_name from public.lead_imports where id = $1", [run.import_id]))[0];
    expect(im.kind).toBe("rapidapi_b2b");
    expect(im.list_name).toMatch(/^Decisores: Construção MA \(\d\d\/\d\d\)$/);
    expect(await db.admin("select distinct source from public.lead_fields where source_ref = $1", [run.import_id])).toEqual([{ source: "rapidapi_b2b" }]);
    await db.query(clock, "select public.source_finish_tick($1,'{}'::jsonb,null)", [t]);
    expect((await db.query<{ r: { deleted: number } }>(as(owner), "select public.undo_lead_import($1) as r", [run.import_id]))[0].r.deleted).toBe(1);
  });

  test("site e-mails: asked once per lead, counted against the sites cap, stored as rapidapi_contact", async () => {
    const { ws, owner, sdr } = await connected();
    await db.query(as(owner), "select public.set_source_cap($1,'rapidapi_sites',2)", [ws]);
    const [l1, l2, l3] = [await addLead(ws), await addLead(ws), await addLead(ws)];
    expect(code((await db.try(as(sdr), "select public.request_site_contact($1,$2,'javascript:alert(1)')", [ws, l1])).error)).toBe("22023");
    expect(await askSite(sdr, ws, l1)).toBe(true);
    expect(await askSite(sdr, ws, l1)).toBe(true); // already in the open run: not counted twice
    expect(await askSite(sdr, ws, l2, "https://beta-build.example.com/")).toBe(true);
    expect((await use(owner, ws)).used_sites).toBe(2);
    expect(await askSite(sdr, ws, l3, "https://gamma-build.example.com/")).toBe(false); // no site left this month

    const t = await sourceTick();
    const work = (await db.query<{ r: { start: { id: string; provider: string; kind: string }[] } }>(clock, "select public.source_next_work($1) as r", [t]))[0].r;
    const run = work.start.find((s) => s.provider === "rapidapi" && s.kind === "contact");
    expect(run).toBeDefined(); // no 10-lead / 10-minute wait for RapidAPI
    await db.query(clock, "select public.source_mark_started($1,$2,'rapidapi','rapidapi')", [t, run!.id]);
    const n = (await db.query<{ n: number }>(clock, "select public.source_add_contacts($1,$2,$3::jsonb,1,0) as n", [
      t,
      run!.id,
      JSON.stringify([{ lead_id: l1, value: "pat@acme-build.example.com", url: "https://acme-build.example.com/team" }]),
    ]))[0].n;
    expect(n).toBe(1);
    expect(await db.admin("select source, status, source_ref from public.lead_fields where lead_id = $1 and field = 'email'", [l1])).toEqual([
      { source: "rapidapi_contact", status: "confirmed", source_ref: "https://acme-build.example.com/team" },
    ]);
    expect((await use(owner, ws)).used_sites).toBe(1); // imported: only the site really read counts
    expect(await askSite(sdr, ws, l1)).toBe(false); // answered in the last 30 days
  });

  test("the Qualificador asks RapidAPI first, then Apify for a lead RapidAPI already read", async () => {
    const { ws } = await connected();
    const lead = await addLead(ws);
    const tick = await beginQualifierTick(db);
    await db.admin("update public.qualifier_queue set locked_by = $1, locked_until = now() + interval '180 seconds' where lead_id = $2", [tick, lead]);
    const ask = () => db.query<{ r: boolean }>(qclock, "select public.qualifier_request_contacts($1,$2,'https://acme-build.example.com/') as r", [tick, lead]).then((x) => x[0].r);
    expect(await ask()).toBe(true);
    expect(await db.admin("select r.provider from public.source_run_leads l join public.source_runs r on r.id = l.run_id where l.lead_id = $1", [lead])).toEqual([{ provider: "rapidapi" }]);
    await db.admin("update public.source_runs r set status = 'imported', found = 1 from public.source_run_leads l where l.run_id = r.id and l.lead_id = $1", [lead]);
    expect(await ask()).toBe(true);
    expect((await db.admin<{ provider: string }>("select r.provider from public.source_run_leads l join public.source_runs r on r.id = l.run_id where l.lead_id = $1 order by r.created_at", [lead])).map((r) => r.provider)).toEqual(["rapidapi", "apify"]);
  });

  test("0034 re-runs over RapidAPI rows; 0033 then 0034 re-run cleanly in order", async () => {
    const sql = (f: string) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    const { ws, owner } = await connected(7);
    await db.pg.exec(sql("0034_rapidapi_source.sql"));
    expect((await use(owner, ws)).monthly_records).toBe(7);
    // 0033 alone would refuse the RapidAPI rows its own checks do not know: the pair re-runs on a database without them
    const fresh = await TestDb.create();
    try {
      for (const f of ["0033_shovels_source.sql", "0034_rapidapi_source.sql"]) await fresh.pg.exec(sql(f));
      const s = await seedSources(fresh);
      await fresh.query(as(s.owner), "select public.set_source_connection($1,'rapidapi',$2,'RA12',null)", [s.ws, SOURCE_CIPHER]);
      expect(code((await fresh.try(as(s.owner), "select public.set_source_connection($1,'serpapi',$2,'AB12',null)", [s.ws, SOURCE_CIPHER])).error)).toBe("22023");
    } finally {
      await fresh.pg.close();
    }
  });
});
