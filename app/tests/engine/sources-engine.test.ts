import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { sealKey } from "@/lib/sources/connections";
import { rpcSourceStore } from "@/lib/sources/store";
import { runSourceTick } from "@/lib/sources/tick";
import { TestDb, as, setSchedulerToken } from "../db/helpers";
import { TOKEN } from "../db/scheduler-seed";
import { beginTick, clock, seedHunter } from "../db/hunter-seed";
import { MAPS_QUERY, seedSources } from "../db/sources-seed";
import { fakeHttp } from "../unit/sources-fakes";
import { pgRpc } from "./pg-rpc";

// F3d Task 6 over PGlite: the real tick, the real 0013 functions, a fake Apify.
const KEY = "apify_api_TESTKEY0000";
const A = "https://api.apify.com/v2";
const original = process.env.MAILBOX_ENC_KEY;
let db: TestDb;
beforeAll(async () => {
  process.env.MAILBOX_ENC_KEY = randomBytes(32).toString("base64");
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
afterAll(async () => {
  if (original === undefined) delete process.env.MAILBOX_ENC_KEY;
  else process.env.MAILBOX_ENC_KEY = original;
  await db.pg.close();
});

const store = () => rpcSourceStore(pgRpc(db, TOKEN));
const tick = (http: ReturnType<typeof fakeHttp>) => runSourceTick({ store: store(), http, now: () => Date.now() });
/** Replaces the dummy ciphertext with a real one for this workspace. */
async function seal(ws: string, provider: "apify" | "apollo", key: string) {
  await db.admin("update public.source_connections set secret_ciphertext = $3 where workspace_id = $1 and provider = $2", [ws, provider, sealKey(ws, provider, key)]);
}
const apify = (status: string) =>
  fakeHttp({
    [`POST ${A}/acts/compass~crawler-google-places/runs`]: { status: 201, json: { data: { id: "AR1", defaultDatasetId: "DS1" } } },
    [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status, usageTotalUsd: 0.07 } } },
    [`GET ${A}/datasets/DS1/items`]: {
      status: 200,
      json: [
        { title: "Acme Builders", countryCode: "US", website: "https://acme.example", phone: "508-555-0101", city: "Worcester" },
        { title: "Beta Homes", countryCode: "US", website: "https://beta.example" },
      ],
    },
  });

describe("sources tick against the database", () => {
  test("a succeeded run is imported exactly once across ticks", async () => {
    const { ws, owner } = await seedSources(db, { apifyCap: 50 });
    await seal(ws, "apify", KEY);
    const runId = (await db.query<{ id: string }>(as(owner), "select public.enqueue_source_run($1,'maps',$2::jsonb,50) as id", [ws, JSON.stringify(MAPS_QUERY)]))[0].id;

    const t1 = await tick(apify("RUNNING"));
    expect(t1).toMatchObject({ outcome: "ok", started: 1, imported: 0 });
    // the tick dies before importing: the next one sees SUCCEEDED and imports
    const t2 = await tick(apify("SUCCEEDED"));
    expect(t2).toMatchObject({ outcome: "ok", polled: 1, imported: 1, failed: 0 });
    const t3 = await tick(apify("SUCCEEDED"));
    expect(t3).toMatchObject({ outcome: "ok", started: 0, polled: 0, imported: 0 });

    const r = (await db.admin<{ status: string; cost_usd: string; found: number; dropped: number; import_id: string }>("select status, cost_usd, found, dropped, import_id from public.source_runs where id = $1", [runId]))[0];
    expect(r).toMatchObject({ status: "imported", found: 2, dropped: 0 });
    expect(Number(r.cost_usd)).toBe(0.07);
    expect((await db.admin<{ n: number }>("select count(*)::int n from public.lead_imports where workspace_id = $1 and kind = 'apify_maps'", [ws]))[0].n).toBe(1);
    expect((await db.admin<{ n: number }>("select count(*)::int n from public.leads where workspace_id = $1", [ws]))[0].n).toBe(2);
  });

  test('a Caçador run with Maps on becomes an import "Maps · {agent} · dd/mm" that hunter_known_companies includes', async () => {
    const userId = randomBytes(4).toString("hex").padStart(8, "0") + "-0000-4000-8000-000000000001";
    const seed = await seedHunter(db, { userId, schedule: "weekly" });
    await db.query(as(userId), "select public.set_source_connection($1,'apify',$2,'AB12',50)", [seed.ws, "v1:" + "Z".repeat(60)]);
    await seal(seed.ws, "apify", KEY);
    await db.query(as(userId), "select public.set_agent_source_settings($1,$2::jsonb)", [
      seed.agent,
      JSON.stringify({ maps_on: true, maps_terms: ["general contractor"], maps_location: "Worcester, MA", maps_max: 50 }),
    ]);
    // the hunter clock creates the research run
    const ht = await beginTick(db);
    await pgRpc(db, TOKEN)("hunter_due_work", { p_tick: ht });
    const run = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [seed.agent]))[0].id;
    await db.admin("update public.research_runs set status = 'running' where id = $1", [run]);

    await tick(apify("RUNNING"));
    const t = await tick(apify("SUCCEEDED"));
    expect(t.imported).toBe(1);
    const imp = (await db.admin<{ list_name: string; id: string }>("select id, list_name from public.lead_imports where workspace_id = $1 and kind = 'apify_maps'", [seed.ws]))[0];
    expect(imp.list_name).toMatch(/^Maps · .+ · \d{2}\/\d{2}$/);
    await pgRpc(db, TOKEN)("hunter_finish_tick", { p_tick: ht, p_counts: {}, p_error: null });
    await setSchedulerToken(db, TOKEN);
    const ht2 = await beginTick(db);
    const known = (await db.query<{ r: unknown }>(clock, "select public.hunter_known_companies($1,$2) as r", [ht2, run]))[0].r;
    expect(JSON.stringify(known)).toContain("Acme Builders");
    await pgRpc(db, TOKEN)("hunter_finish_tick", { p_tick: ht2, p_counts: {}, p_error: null });
  });
});
