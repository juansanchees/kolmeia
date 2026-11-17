import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { TestDb, as, setSchedulerToken } from "./helpers";
import { TOKEN } from "./scheduler-seed";
import { clock } from "./hunter-seed";
import { SOURCE_CIPHER, seedSources } from "./sources-seed";
import { row } from "./lists-seed";

// Migration 0033: Shovels as a third connected source (monthly records cap, clamped enqueue, its own list kind). Fictional data only.

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
beforeEach(async () => {
  await db.admin("update public.source_ticks set finished_at = now() where finished_at is null");
});
afterAll(async () => {
  await db.pg.close();
});

const code = (e: unknown) => (e as { code?: string }).code;
const Q = { place: "Worcester", tag: "hvac", label: "HVAC Worcester" };
const enqueue = (owner: string, ws: string, query: unknown = Q, max = 50) =>
  db.try<{ id: string }>(as(owner), "select public.enqueue_source_run($1,'shovels',$2::jsonb,$3) as id", [ws, JSON.stringify(query), max]);
const add = async (owner: string, ws: string, query: unknown = Q, max = 50) =>
  (await db.query<{ id: string }>(as(owner), "select public.enqueue_source_run($1,'shovels',$2::jsonb,$3) as id", [ws, JSON.stringify(query), max]))[0].id;
const maxOf = async (id: string) => (await db.admin<{ max_results: number }>("select max_results from public.source_runs where id = $1", [id]))[0].max_results;
const month = async (owner: string, ws: string) =>
  (await db.query<{ monthly_records: number; used_month: number }>(as(owner), "select monthly_records, used_month from public.list_source_connections($1) where provider = 'shovels'", [ws]))[0];

async function connected(cap: number | null = null) {
  const s = await seedSources(db);
  await db.query(as(s.owner), "select public.set_source_connection($1,'shovels',$2,'EF56',$3)", [s.ws, SOURCE_CIPHER, cap]);
  return s;
}

describe("0033 shovels source", () => {
  test("'shovels' is accepted as a provider; an unknown provider is still refused; cap is whole records 50..50000", async () => {
    const { ws, owner, sdr } = await connected();
    expect(await month(owner, ws)).toEqual({ monthly_records: 500, used_month: 0 });
    expect((await db.query(as(sdr), "select provider from public.list_source_connections($1)", [ws])).map((r) => r.provider)).toEqual(["apify", "apollo", "shovels"]);
    expect(code((await db.try(as(owner), "select public.set_source_connection($1,'serpapi',$2,'AB12',null)", [ws, SOURCE_CIPHER])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'serpapi',10)", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.delete_source_connection($1,'serpapi')", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.enqueue_source_run($1,'serpapi','{}'::jsonb,10)", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'shovels',49)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'shovels',50001)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'shovels',100.5)", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(sdr), "select public.set_source_cap($1,'shovels',100)", [ws])).error)).toBe("42501");
    await db.query(as(owner), "select public.set_source_cap($1,'shovels',1000)", [ws]);
    // a new key keeps the cap; the table check still binds every provider to its own cap column
    await db.query(as(owner), "select public.set_source_connection($1,'shovels',$2,'GH78',null)", [ws, SOURCE_CIPHER]);
    expect((await month(owner, ws)).monthly_records).toBe(1000);
    await expect(db.admin("update public.source_connections set daily_calls = 5 where workspace_id = $1 and provider = 'shovels'", [ws])).rejects.toMatchObject({ code: "23514" });
    await expect(db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results) values ($1,'shovels','maps',1)", [ws])).rejects.toMatchObject({ code: "23514" });
    await expect(db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results) values ($1,'serpapi','shovels',1)", [ws])).rejects.toMatchObject({ code: "23514" });
  });

  test("enqueue validates the query and never asks past the monthly cap: clamped, then refused", async () => {
    const { ws, owner } = await connected(60);
    for (const [q, max] of [
      [{ place: "Worcester", tag: "solar" }, 10],
      [{ place: "Worcester", tag: "all", extra: 1 }, 10],
      [{ place: "x".repeat(81), tag: "all" }, 10],
      [{ tag: "all" }, 10],
      [Q, 101],
    ] as const) {
      expect(code((await enqueue(owner, ws, q, max)).error), JSON.stringify(q)).toBe("22023");
    }
    const a = await add(owner, ws, Q, 50);
    expect(await maxOf(a)).toBe(50);
    expect((await month(owner, ws)).used_month).toBe(50); // a queued run counts what it may take
    const b = await add(owner, ws, { place: "", tag: "all" }, 50);
    expect(await maxOf(b)).toBe(10); // only 10 left of 60
    expect((await enqueue(owner, ws, Q, 5)).error?.message).toBe("source_cap");
  });

  test("tick path: import makes a 'Shovels: <label> (dd/mm)' list of kind shovels; the month counts what Shovels returned; undo works", async () => {
    const { ws, owner } = await connected();
    // other tests' queued runs would take the 3 start slots first
    await db.admin("update public.source_runs set status = 'refused', error = 'test' where status = 'queued'");
    const id = await add(owner, ws, Q, 50);
    await setSchedulerToken(db, TOKEN);
    const t = (await db.query<{ r: { tick_id: string } }>(clock, "select public.source_begin_tick() as r"))[0].r.tick_id;
    const work = (await db.query<{ r: { start: { id: string; provider: string; ciphertext: string }[] } }>(clock, "select public.source_next_work($1) as r", [t]))[0].r;
    expect(work.start.find((s) => s.id === id)).toMatchObject({ provider: "shovels", ciphertext: SOURCE_CIPHER });
    await db.query(clock, "select public.source_mark_started($1,$2,'shovels','')", [t, id]);
    const rows = [row(1, "Acme Mechanical", { phone: "508-555-0101", note: "Shovels: 3 alvarás ativos (12 meses)" }), row(2, "Beta HVAC", { website: "https://beta-hvac.example" })];
    await db.query(clock, "select public.source_import($1,$2,$3::jsonb,7,5,0)", [t, id, JSON.stringify(rows)]);
    const run = (await db.admin<{ status: string; import_id: string; found: number }>("select status, import_id, found from public.source_runs where id = $1", [id]))[0];
    expect(run).toMatchObject({ status: "imported", found: 7 });
    const im = (await db.admin<{ kind: string; file_name: string; list_name: string; new_count: number }>("select kind, file_name, list_name, new_count from public.lead_imports where id = $1", [run.import_id]))[0];
    expect(im).toMatchObject({ kind: "shovels", file_name: "Shovels (alvarás)", new_count: 2 });
    expect(im.list_name).toMatch(/^Shovels: HVAC Worcester \(\d\d\/\d\d\)$/);
    const srcs = await db.admin<{ source: string }>("select distinct source from public.lead_fields where source_ref = $1", [run.import_id]);
    expect(srcs).toEqual([{ source: "shovels" }]);
    expect((await month(owner, ws)).used_month).toBe(7);
    await db.query(clock, "select public.source_finish_tick($1,'{}'::jsonb,null)", [t]);
    expect((await db.query<{ r: { deleted: number } }>(as(owner), "select public.undo_lead_import($1) as r", [run.import_id]))[0].r.deleted).toBe(2);
    // disconnecting refuses the queued Shovels runs
    const q = await add(owner, ws, Q, 10);
    await db.query(as(owner), "select public.delete_source_connection($1,'shovels')", [ws]);
    expect((await db.admin<{ status: string; error: string }>("select status, error from public.source_runs where id = $1", [q]))[0]).toEqual({ status: "refused", error: "disconnected" });
  });
});
