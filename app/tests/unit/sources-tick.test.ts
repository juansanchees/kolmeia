import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { sealKey } from "@/lib/sources/connections";
import type { SourceCounts, SourceRunRow, SourceTickStore } from "@/lib/sources/store";
import { runSourceTick } from "@/lib/sources/tick";
import { fakeHttp } from "./sources-fakes";

const WS = "11111111-1111-4111-8111-111111111111";
const APIFY_KEY = "apify_api_TESTKEY0000";
const APOLLO_KEY = "apollo_TESTKEY0000";
const original = process.env.MAILBOX_ENC_KEY;
beforeAll(() => {
  process.env.MAILBOX_ENC_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (original === undefined) delete process.env.MAILBOX_ENC_KEY;
  else process.env.MAILBOX_ENC_KEY = original;
});

const A = "https://api.apify.com/v2";
const NOW = Date.parse("2026-11-14T15:00:00Z");

function run(o: Partial<SourceRunRow> & { id: string }): SourceRunRow {
  const provider = o.provider ?? "apify";
  return {
    workspace_id: WS,
    provider,
    kind: provider === "apollo" ? "apollo" : "maps",
    query: provider === "apollo" ? { locations: ["Massachusetts, US"], naics: ["236"], pages: 1, label: "x" } : { terms: ["general contractor"], location: "Worcester, MA", label: "GCs" },
    max_results: 50,
    reserve_usd: 0.5,
    external_run_id: null,
    dataset_id: null,
    started_at: null,
    label: "GCs",
    ciphertext: sealKey(WS, provider, provider === "apollo" ? APOLLO_KEY : APIFY_KEY),
    ...o,
  };
}

type Log = { fn: string; args: unknown[] }[];
function fakeStore(work: { start?: SourceRunRow[]; poll?: SourceRunRow[] }, o: { busy?: boolean; importError?: (runId: string) => unknown; failOn?: string } = {}) {
  const log: Log = [];
  const rec = (fn: string, ...args: unknown[]) => log.push({ fn, args });
  const store: SourceTickStore = {
    async beginTick() {
      rec("begin");
      return o.busy ? { tickId: "", busy: true } : { tickId: "T1", busy: false };
    },
    async finishTick(_t: string, counts: SourceCounts, error: string | null) {
      rec("finish", counts, error);
    },
    async enqueueAgentRuns() {
      rec("enqueue");
      return 0;
    },
    async nextWork() {
      rec("nextWork");
      return { start: work.start ?? [], poll: work.poll ?? [] };
    },
    async markStarted(_t, id, ext, ds) {
      rec("started", id, ext, ds);
      if (o.failOn === id) throw new Error("db down");
    },
    async markFailed(_t, id, err, cost) {
      rec("failed", id, err, cost);
    },
    async importRows(_t, id, rows, found, dropped, cost) {
      rec("import", id, rows, found, dropped, cost);
      const e = o.importError?.(id);
      if (e) throw e;
      return { new: rows.length, merged: 0 };
    },
  };
  return { store, log, of: (fn: string) => log.filter((l) => l.fn === fn) };
}

describe("runSourceTick", () => {
  test("busy: nothing runs", async () => {
    const f = fakeStore({}, { busy: true });
    const http = fakeHttp({});
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toEqual({ outcome: "busy", started: 0, polled: 0, imported: 0, failed: 0 });
    expect(f.log.map((l) => l.fn)).toEqual(["begin"]);
    expect(http.calls).toHaveLength(0);
  });

  test("a queued maps run starts with its reserve as maxTotalChargeUsd", async () => {
    const f = fakeStore({ start: [run({ id: "R1", reserve_usd: 0.8, max_results: 200 })] });
    const http = fakeHttp({ [`POST ${A}/acts/compass~crawler-google-places/runs`]: { status: 201, json: { data: { id: "AR1", defaultDatasetId: "DS1" } } } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toEqual({ outcome: "ok", started: 1, polled: 0, imported: 0, failed: 0 });
    expect(http.calls[0].url).toContain("maxTotalChargeUsd=0.8");
    expect(http.calls[0].headers.Authorization).toBe(`Bearer ${APIFY_KEY}`);
    expect((http.calls[0].body as { searchStringsArray: string[] }).searchStringsArray).toEqual(["general contractor"]);
    expect(f.of("started")[0].args).toEqual(["R1", "AR1", "DS1"]);
    expect(f.log.at(-1)?.fn).toBe("finish");
  });

  test("a run still RUNNING is left for the next tick", async () => {
    const f = fakeStore({ poll: [run({ id: "R1", external_run_id: "AR1", dataset_id: "DS1", started_at: new Date(NOW - 60_000).toISOString() })] });
    const http = fakeHttp({ [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status: "RUNNING" } } } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", polled: 1, imported: 0, failed: 0 });
    expect(f.of("import")).toHaveLength(0);
    expect(f.of("failed")).toHaveLength(0);
  });

  const succeeded = (usage?: number) =>
    fakeHttp({
      [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status: "SUCCEEDED", ...(usage === undefined ? {} : { usageTotalUsd: usage }) } } },
      [`GET ${A}/datasets/DS1/items`]: {
        status: 200,
        json: [
          { title: "Acme Builders", countryCode: "US", website: "https://acme.example", phone: "508-555-0101" },
          { title: "Nameless Ltd", countryCode: "CA" },
          { title: "No Country Co" },
          { permanentlyClosed: true, title: "Closed Inc", countryCode: "US" },
        ],
      },
    });
  const polling = () => run({ id: "R1", external_run_id: "AR1", dataset_id: "DS1", started_at: new Date(NOW - 60_000).toISOString() });

  test("settle uses usageTotalUsd, else the reserve; places without countryCode are kept and counted", async () => {
    const a = fakeStore({ poll: [polling()] });
    const r = await runSourceTick({ store: a.store, http: succeeded(0.63), now: () => NOW });
    expect(r).toMatchObject({ polled: 1, imported: 1 });
    const imp = a.of("import")[0].args as [string, { name: string }[], number, number, number];
    expect(imp[1].map((x) => x.name)).toEqual(["Acme Builders", "No Country Co"]);
    expect(imp.slice(2)).toEqual([4, 2, 0.63]);
    const b = fakeStore({ poll: [polling()] });
    await runSourceTick({ store: b.store, http: succeeded(), now: () => NOW });
    expect(b.of("import")[0].args[4]).toBe(0.5);
  });

  test("a failed Apify run is marked failed with the usage it reports", async () => {
    const f = fakeStore({ poll: [polling()] });
    const http = fakeHttp({ [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status: "TIMED-OUT", usageTotalUsd: 0.12 } } } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r.failed).toBe(1);
    expect(f.of("failed")[0].args).toEqual(["R1", "timed_out", 0.12]);
  });

  test("a 404 when polling marks the run failed not_found", async () => {
    const f = fakeStore({ poll: [polling()] });
    const http = fakeHttp({ [`GET ${A}/actor-runs/AR1`]: { status: 404, json: { error: {} } } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r.failed).toBe(1);
    expect(f.of("failed")[0].args).toEqual(["R1", "not_found", null]);
  });

  test("a stale run is aborted and failed", async () => {
    const f = fakeStore({ poll: [run({ id: "R1", external_run_id: "AR1", dataset_id: "DS1", started_at: new Date(NOW - 16 * 60_000).toISOString() })] });
    const http = fakeHttp({
      [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status: "RUNNING" } } },
      [`POST ${A}/actor-runs/AR1/abort`]: { status: 200, json: { data: {} } },
    });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r.failed).toBe(1);
    expect(http.calls.some((c) => c.method === "POST" && c.url.endsWith("/abort"))).toBe(true);
    expect(f.of("failed")[0].args.slice(0, 2)).toEqual(["R1", "stale"]);
  });

  const apolloHttp = (items: unknown[]) => fakeHttp({ "POST https://api.apollo.io/api/v1/mixed_companies/search": { status: 200, json: { organizations: items } } });

  test("apollo runs map, filter and import in one tick", async () => {
    const f = fakeStore({ start: [run({ id: "R2", provider: "apollo" })] });
    const http = apolloHttp([
      { name: "Alpha Builders", primary_domain: "alpha.example" },
      { name: "Foreign Ltd", primary_domain: "foreign.co.uk" },
      { name: "No Domain" },
    ]);
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", started: 1, imported: 1, failed: 0 });
    expect(f.of("started")[0].args).toEqual(["R2", "apollo", "apollo"]);
    const imp = f.of("import")[0].args as [string, { name: string }[], number, number, number];
    expect(imp[1].map((x) => x.name)).toEqual(["Alpha Builders"]);
    expect(imp.slice(2)).toEqual([3, 2, 0]);
    expect(http.calls[0].headers["X-Api-Key"]).toBe(APOLLO_KEY);
  });

  test("an apollo run with zero results is a visible zero, not an error", async () => {
    const f = fakeStore({ start: [run({ id: "R2", provider: "apollo" })] });
    const r = await runSourceTick({ store: f.store, http: apolloHttp([]), now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", imported: 1, failed: 0 });
    expect(f.of("import")[0].args).toEqual(["R2", [], 0, 0, 0]);
  });

  test("source_import 22023 (already imported) is handled, not a failure", async () => {
    const f = fakeStore({ poll: [polling()] }, { importError: () => Object.assign(new Error("run is not importable"), { code: "22023" }) });
    const r = await runSourceTick({ store: f.store, http: succeeded(0.1), now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", imported: 0, failed: 0 });
    expect(f.of("failed")).toHaveLength(0);
  });

  test("one failing run does not stop the others; finishTick always runs; errors carry no key", async () => {
    const f = fakeStore(
      { start: [run({ id: "BAD", reserve_usd: 0.5 }), run({ id: "OK", reserve_usd: 0.6 })], poll: [polling()] },
      {},
    );
    const http = fakeHttp({
      [`POST ${A}/acts/compass~crawler-google-places/runs?maxTotalChargeUsd=0.5`]: new Error(`socket hang up ${APIFY_KEY}`),
      [`POST ${A}/acts/compass~crawler-google-places/runs?maxTotalChargeUsd=0.6`]: { status: 201, json: { data: { id: "AR9", defaultDatasetId: "DS9" } } },
      [`GET ${A}/actor-runs/AR1`]: { status: 401, json: { echo: APIFY_KEY } },
    });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", started: 1, failed: 2 });
    expect(f.of("started")).toHaveLength(1);
    expect(f.log.at(-1)?.fn).toBe("finish");
    expect(JSON.stringify(f.log)).not.toContain(APIFY_KEY);
  });

  test("a database error on one run is reported but later runs and finishTick still happen", async () => {
    const f = fakeStore({ start: [run({ id: "R1" }), run({ id: "R2" })] }, { failOn: "R1" });
    const http = fakeHttp({ [`POST ${A}/acts/`]: { status: 201, json: { data: { id: "AR", defaultDatasetId: "DS" } } } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(f.of("started").map((l) => l.args[0])).toEqual(["R1", "R2"]);
    expect(r.started).toBeGreaterThanOrEqual(1);
    expect(f.log.at(-1)?.fn).toBe("finish");
  });
});
