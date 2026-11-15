import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { sealKey } from "@/lib/sources/connections";
import type { SourceCounts, SourceRunRow, SourceTickStore } from "@/lib/sources/store";
import { runSourceTick } from "@/lib/sources/tick";
import { SourceHttpError } from "@/lib/sources/http";
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
function fakeStore(work: { start?: SourceRunRow[]; poll?: SourceRunRow[] }, o: { contactLeads?: { leadId: string; startUrl: string }[]; contactsError?: () => unknown; busy?: boolean; importError?: (runId: string) => unknown; failOn?: string; failError?: () => unknown; startedError?: (runId: string) => unknown } = {}) {
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
      const e = o.startedError?.(id);
      if (e) throw e;
    },
    async markFailed(_t, id, err, cost) {
      rec("failed", id, err, cost);
      const e = o.failError?.();
      if (e) throw e;
    },
    async importRows(_t, id, rows, found, dropped, cost) {
      rec("import", id, rows, found, dropped, cost);
      const e = o.importError?.(id);
      if (e) throw e;
      return { new: rows.length, merged: 0 };
    },
    async contactLeads(_t, id) {
      rec("contactLeads", id);
      return o.contactLeads ?? [];
    },
    async addContacts(_t, id, rows, found, cost) {
      rec("addContacts", id, rows, found, cost);
      const e = o.contactsError?.();
      if (e) throw e;
      return rows.length;
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

  test("import inputs are clamped before the call (rows <= max+20, cost <= 1000)", async () => {
    const f = fakeStore({ poll: [{ ...polling(), max_results: 1 }] });
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `Firm ${i} Builders`, countryCode: "US" }));
    const http = fakeHttp({
      [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status: "SUCCEEDED", usageTotalUsd: 5000 } } },
      [`GET ${A}/datasets/DS1/items`]: { status: 200, json: items },
    });
    await runSourceTick({ store: f.store, http, now: () => NOW });
    const a = f.of("import")[0].args as [string, unknown[], number, number, number];
    expect(a[1]).toHaveLength(21);
    expect(a.slice(2)).toEqual([30, 9, 1000]);
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
    expect(f.of("failed")[0].args).toEqual(["R1", "stale", null]);
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
    expect(f.of("started")[0].args).toEqual(["R2", "apollo", ""]);
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

  test("a SUCCEEDED run whose import is refused (22023) fails once as import_refused and is not re-polled", async () => {
    const f = fakeStore({ poll: [polling()] }, { importError: () => Object.assign(new Error("run is not importable"), { code: "22023" }) });
    const http = succeeded(0.1);
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", imported: 0, failed: 1 });
    expect(f.of("failed")).toHaveLength(1);
    expect(f.of("failed")[0].args).toEqual(["R1", "import_refused", 0.1]);
    expect(http.calls.filter((c) => c.url.endsWith("/actor-runs/AR1"))).toHaveLength(1);
  });

  test("if markFailed itself answers 22023 (already settled) nothing is counted and nothing throws", async () => {
    const f = fakeStore({ poll: [polling()] }, { importError: () => Object.assign(new Error("x"), { code: "22023" }), failError: () => Object.assign(new Error("x"), { code: "22023" }) });
    const r = await runSourceTick({ store: f.store, http: succeeded(0.1), now: () => NOW });
    expect(r).toMatchObject({ outcome: "ok", imported: 0, failed: 0 });
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

  const startRoute = `POST ${A}/acts/compass~crawler-google-places/runs`;
  const startOk = { status: 201, json: { data: { id: "AR9", defaultDatasetId: "DS9" } } };

  test("a database error on one run is reported, the Apify run is aborted and settled at the reserve, later runs and finishTick still happen", async () => {
    const f = fakeStore({ start: [run({ id: "R1" }), run({ id: "R2" })] }, { failOn: "R1" });
    const http = fakeHttp({ [startRoute]: startOk, [`POST ${A}/actor-runs/AR9/abort`]: { status: 200, json: {} } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(f.of("started").map((l) => l.args[0])).toEqual(["R1", "R2"]);
    expect(f.of("failed").map((l) => l.args)).toEqual([["R1", "start_unrecorded", 0.5]]);
    expect(http.calls.some((c) => c.url.endsWith("/abort"))).toBe(true);
    expect(r).toMatchObject({ started: 1, failed: 1 });
    expect(f.log.at(-1)?.fn).toBe("finish");
  });

  test.each([
    ["timeout", new SourceHttpError("timeout"), 0.5],
    ["network", new SourceHttpError("network"), 0.5],
    ["5xx", { status: 503, json: {} }, 0.5],
    ["429", { status: 429, json: {} }, 0.5],
    ["bad_response", { status: 201, json: { data: {} } }, 0.5],
    ["401", { status: 401, json: { echo: APIFY_KEY } }, 0],
    ["403", { status: 403, json: {} }, 0],
    ["400", { status: 400, json: {} }, 0],
  ])("start failure %s settles at cost %s", async (_n, route, cost) => {
    const f = fakeStore({ start: [run({ id: "R1" })] });
    const http = fakeHttp({ [startRoute]: route as never });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r.failed).toBe(1);
    expect(f.of("failed")[0].args[2]).toBe(cost);
    expect(f.of("started")).toHaveLength(0);
  });

  test("a key that fails to open settles at 0", async () => {
    const f = fakeStore({ start: [run({ id: "R1", ciphertext: "v1:garbage" })] });
    const r = await runSourceTick({ store: f.store, http: fakeHttp({}), now: () => NOW });
    expect(r.failed).toBe(1);
    expect(f.of("failed")[0].args).toEqual(["R1", "key_unreadable", 0]);
  });

  test("ids Apify returned that fail validation: abort, then settle at the reserve", async () => {
    const f = fakeStore({ start: [run({ id: "R1" })] });
    const http = fakeHttp({ [startRoute]: { status: 201, json: { data: { id: "A/../B", defaultDatasetId: "DS9" } } }, [`POST ${A}/actor-runs/`]: { status: 200, json: {} } });
    await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(http.calls.some((c) => c.url.includes("/abort"))).toBe(true);
    expect(f.of("started")).toHaveLength(0);
    expect(f.of("failed")[0].args).toEqual(["R1", "bad_response", 0.5]);
  });

  test("markStarted answering 22023 aborts the Apify run and settles at the reserve", async () => {
    const f = fakeStore({ start: [run({ id: "R1" })] }, { startedError: () => Object.assign(new Error("x"), { code: "22023" }) });
    const http = fakeHttp({ [startRoute]: startOk, [`POST ${A}/actor-runs/AR9/abort`]: { status: 200, json: {} } });
    await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(http.calls.some((c) => c.url.endsWith("/abort"))).toBe(true);
    expect(f.of("failed")[0].args).toEqual(["R1", "start_refused", 0.5]);
  });

  test("the budget only limits polls: every claimed start still runs", async () => {
    let t = NOW;
    const f = fakeStore({
      start: [run({ id: "S1" }), run({ id: "S2" }), run({ id: "S3" })],
      poll: [run({ id: "P1", external_run_id: "AR1", dataset_id: "DS1", started_at: new Date(NOW - 1000).toISOString() })],
    });
    const http = fakeHttp({ [startRoute]: startOk, [`GET ${A}/actor-runs/AR1`]: { status: 200, json: { data: { status: "RUNNING" } } } });
    const r = await runSourceTick({ store: f.store, http, now: () => (t += 20_000), budgetMs: 10_000 });
    expect(r.started).toBe(3);
    expect(r.polled).toBe(0);
    expect(f.log.at(-1)?.fn).toBe("finish");
  });

  test("budgetMs 0: begin, enqueue, claimed starts and finish still run, with no polls", async () => {
    const f = fakeStore({
      start: [run({ id: "S1" })],
      poll: [run({ id: "P1", external_run_id: "AR1", dataset_id: "DS1", started_at: new Date(NOW - 1000).toISOString() })],
    });
    const http = fakeHttp({ [startRoute]: startOk });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW, budgetMs: 0 });
    expect(r.started).toBe(1);
    expect(r.polled).toBe(0);
    expect(f.log.map((l) => l.fn)).toEqual(["begin", "enqueue", "nextWork", "started", "finish"]);
  });

  test("an Apollo run found in poll (crash leftover) fails as interrupted", async () => {
    const f = fakeStore({ poll: [run({ id: "R2", provider: "apollo", started_at: new Date(NOW - 1000).toISOString() })] });
    const r = await runSourceTick({ store: f.store, http: fakeHttp({}), now: () => NOW });
    expect(r.failed).toBe(1);
    expect(f.of("failed")[0].args).toEqual(["R2", "interrupted", 0]);
  });

  test("a transient poll error is left for the next tick, but ages out after 2x the stale window", async () => {
    const http = () => fakeHttp({ [`GET ${A}/actor-runs/AR1`]: new SourceHttpError("timeout") });
    const young = fakeStore({ poll: [polling()] });
    expect(await runSourceTick({ store: young.store, http: http(), now: () => NOW })).toMatchObject({ outcome: "ok", failed: 0 });
    expect(young.of("failed")).toHaveLength(0);
    const old = fakeStore({ poll: [run({ id: "R1", external_run_id: "AR1", dataset_id: "DS1", started_at: new Date(NOW - 31 * 60_000).toISOString() })] });
    expect((await runSourceTick({ store: old.store, http: http(), now: () => NOW })).failed).toBe(1);
    expect(old.of("failed")[0].args).toEqual(["R1", "stale", null]);
  });
});

describe("contact runs (P2b)", () => {
  const CONTACT = "vdrmota~contact-info-scraper";
  const leads = [
    { leadId: "L1", startUrl: "https://acme.example.com/" },
    { leadId: "L2", startUrl: "https://www.bravo.example.org/home" },
  ];
  const contact = (o: Partial<SourceRunRow> = {}) => run({ id: "C1", kind: "contact", query: { label: "Contatos" }, max_results: 10, reserve_usd: 0.5, label: "Contatos", ...o });

  test("a queued contact run starts the contact scraper on its leads' sites, with the reserve as the charge cap", async () => {
    const f = fakeStore({ start: [contact()] }, { contactLeads: leads });
    const http = fakeHttp({ [`POST ${A}/acts/${CONTACT}/runs`]: { status: 201, json: { data: { id: "AC1", defaultDatasetId: "DC1" } } } });
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toEqual({ outcome: "ok", started: 1, polled: 0, imported: 0, failed: 0 });
    expect(http.calls[0].url).toContain("maxTotalChargeUsd=0.5");
    expect(http.calls[0].body).toMatchObject({
      startUrls: [{ url: "https://acme.example.com/" }, { url: "https://www.bravo.example.org/home" }],
      maxDepth: 1,
      sameDomain: true,
      mergeContacts: true,
      proxyConfig: { useApifyProxy: true },
    });
    expect(f.of("started")[0].args).toEqual(["C1", "AC1", "DC1"]);
  });

  test("a contact run without leads fails no_leads at zero and never calls Apify", async () => {
    const f = fakeStore({ start: [contact()] }, { contactLeads: [] });
    const http = fakeHttp({});
    const r = await runSourceTick({ store: f.store, http, now: () => NOW });
    expect(r).toMatchObject({ failed: 1, started: 0 });
    expect(f.of("failed")[0].args).toEqual(["C1", "no_leads", 0]);
    expect(http.calls).toHaveLength(0);
  });

  const done = (usage?: number) =>
    fakeHttp({
      [`GET ${A}/actor-runs/AC1`]: { status: 200, json: { data: { status: "SUCCEEDED", ...(usage === undefined ? {} : { usageTotalUsd: usage }) } } },
      [`GET ${A}/datasets/DC1/items`]: {
        status: 200,
        json: [
          { url: "https://acme.example.com/contact", originalStartUrl: "https://acme.example.com/", emails: ["Info@acme.example.com", "x@domain.com"], phones: ["+1 508 555 0100"] },
          { url: "https://www.bravo.example.org/about", originalStartUrl: "https://www.bravo.example.org/home", emails: ["hi@bravo.example.org", "owner@gmail.com", "site-by@webagency.example.net"] },
        ],
      },
    });
  const polling = () => contact({ external_run_id: "AC1", dataset_id: "DC1", started_at: new Date(NOW - 60_000).toISOString() });

  test("a finished contact run stores the kept e-mails per lead and settles at the cost Apify reports, else the reserve", async () => {
    const a = fakeStore({ poll: [polling()] }, { contactLeads: leads });
    const r = await runSourceTick({ store: a.store, http: done(0.07), now: () => NOW });
    expect(r).toMatchObject({ polled: 1, imported: 1, failed: 0 });
    expect(a.of("addContacts")[0].args).toEqual([
      "C1",
      [
        { leadId: "L1", value: "info@acme.example.com", url: "https://acme.example.com/contact" },
        { leadId: "L2", value: "hi@bravo.example.org", url: "https://www.bravo.example.org/about" },
        // free mail read on the lead's own page is kept; the web agency's address on the same page is not
        { leadId: "L2", value: "owner@gmail.com", url: "https://www.bravo.example.org/about" },
      ],
      2,
      0.07,
    ]);
    expect(a.of("import")).toHaveLength(0);
    const b = fakeStore({ poll: [polling()] }, { contactLeads: leads });
    await runSourceTick({ store: b.store, http: done(), now: () => NOW });
    expect(b.of("addContacts")[0].args[3]).toBe(0.5);
  });

  test("a refused store (22023) fails the contact run once as import_refused; a failed Apify run settles like Maps", async () => {
    const a = fakeStore({ poll: [polling()] }, { contactLeads: leads, contactsError: () => Object.assign(new Error("x"), { code: "22023" }) });
    const r = await runSourceTick({ store: a.store, http: done(0.07), now: () => NOW });
    expect(r).toMatchObject({ imported: 0, failed: 1 });
    expect(a.of("failed")[0].args).toEqual(["C1", "import_refused", 0.07]);
    const b = fakeStore({ poll: [polling()] }, { contactLeads: leads });
    const http = fakeHttp({ [`GET ${A}/actor-runs/AC1`]: { status: 200, json: { data: { status: "FAILED", usageTotalUsd: 0.2 } } } });
    await runSourceTick({ store: b.store, http, now: () => NOW });
    expect(b.of("failed")[0].args).toEqual(["C1", "failed", 0.2]);
    expect(b.of("addContacts")).toHaveLength(0);
  });
});
