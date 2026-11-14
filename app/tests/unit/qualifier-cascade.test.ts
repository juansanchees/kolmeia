import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { qualifyLead } = await import("@/lib/qualifier/cascade");
import { AiError } from "@/lib/ai/errors";
import type { AiLedger } from "@/lib/ai/gateway";
import type { PlaceHit, PlacesClient } from "@/lib/qualifier/types";
import { FakeTransport } from "../engine/fake-ai";
import { fakeHttp, fakeQualifierStore, field, htmlPage, snapshot } from "./qualifier-fakes";

const SITE = "https://acme-hvac.test/";
const PAGE = htmlPage(`<h1>Acme HVAC</h1><script type="application/ld+json">{"@type":"HVACBusiness","name":"Acme HVAC","telephone":"+1 508-555-0142","address":{"@type":"PostalAddress","streetAddress":"12 Main Street","addressLocality":"Worcester","addressRegion":"MA"}}</script><a href="mailto:hello@acme-hvac.test">Mail</a> <a href="tel:+1-508-555-0142">Call</a>`);

function deps(store: ReturnType<typeof fakeQualifierStore>, http = fakeHttp({ [SITE]: PAGE }), extra: object = {}) {
  let t = 0;
  return { store, tickId: "tick-1", transport: null, http, places: null, sleep: async (ms: number) => void (t += ms), now: () => t, gaps: new Map<string, number>(), ...extra };
}
const steps = (store: { log: unknown[][] }) => store.log.filter((l) => l[0] === "stepDone").map((l) => `${l[2]}:${l[3]}:${l[4]}:${l[5] ?? ""}`);

describe("qualifyLead free cascade", () => {
  test("P2: a lead with only a site gains phone, e-mail and address from its own site, with the URL and excerpt, at no cost", async () => {
    const store = fakeQualifierStore([]);
    const s = snapshot({ nextStep: "p2", fields: [field({ field: "website", value: SITE })] });
    const r = await qualifyLead(s, deps(store));
    expect(r.result).toBe("done");
    const added = store.log.find((l) => l[0] === "addFields")![2] as { field: string; value: string; source: string; status: string; source_ref: string; excerpt: string }[];
    const by = (f: string) => added.find((a) => a.field === f);
    expect(by("phone")).toMatchObject({ value: expect.stringContaining("508"), source: "site", status: "confirmed", source_ref: SITE });
    expect(by("phone")!.excerpt.length).toBeGreaterThan(0);
    expect(by("email")).toMatchObject({ value: "hello@acme-hvac.test", source: "site", source_ref: SITE });
    expect(by("address")).toBeTruthy();
    expect(by("website")).toMatchObject({ value: SITE, status: "confirmed" });
    expect(store.log.some((l) => l[0] === "reservePlaces")).toBe(false);
    expect(steps(store)).toEqual(["p2:ok:p3:", "p3:skipped:p4:", "p4:no_ai:p5:", "p5:no_ai:done:complete"]);
    expect(r.steps).toBe(4);
  });

  test("P2 is skipped without a site and when phone, e-mail and address are already confirmed", async () => {
    const a = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p2" }), deps(a));
    expect(steps(a)[0]).toBe("p2:no_site:p3:");
    const http = fakeHttp({ [SITE]: PAGE });
    const b = fakeQualifierStore([]);
    const s = snapshot({
      nextStep: "p2",
      fields: [
        field({ field: "website", value: SITE }),
        field({ field: "phone", value: "5085550142", status: "confirmed" }),
        field({ field: "email", value: "a@acme-hvac.test", status: "confirmed" }),
        field({ field: "address", value: "12 Main St", status: "confirmed" }),
      ],
    });
    await qualifyLead(s, deps(b, http));
    expect(steps(b)[0]).toBe("p2:skipped:p3:");
    expect(http.calls).toEqual([]);
  });

  test("a site that blocks is \"site_blocked\", no error, and the cascade goes on to the end", async () => {
    const store = fakeQualifierStore([]);
    const http = fakeHttp({ [SITE]: { status: 403 } });
    const r = await qualifyLead(snapshot({ nextStep: "p2", fields: [field({ field: "website", value: SITE })] }), deps(store, http));
    expect(r.result).toBe("done");
    expect(steps(store)[0]).toBe("p2:site_blocked:p3:");
    expect(steps(store).at(-1)).toBe("p5:no_ai:done:complete");
    expect(store.log.some((l) => l[0] === "refute")).toBe(false);
  });

  test("K-3 an imported site that is down is refuted, and a lead with nothing else to reach is dead", async () => {
    const store = fakeQualifierStore([]);
    const web = field({ field: "website", value: SITE });
    const http = fakeHttp({ [SITE]: { status: 404 } });
    const r = await qualifyLead(snapshot({ nextStep: "p2", fields: [web] }), deps(store, http));
    expect(r.result).toBe("done");
    expect(store.log.find((l) => l[0] === "refute")![2]).toEqual([web.id]);
    expect(steps(store)).toEqual(["p2:site_down:done:dead"]);
    // a phone keeps it alive
    const alive = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p2", fields: [web, field({ field: "phone", value: "5085550100" })] }), deps(alive, http));
    expect(steps(alive)[0]).toBe("p2:site_down:p3:");
  });

  test("I-3: a down site is not dead while another non-refuted site is left: it re-queues to p2 and the other gets read", async () => {
    const other = "https://acme-hvac-two.test/";
    const down = field({ field: "website", value: SITE });
    const second = field({ field: "website", value: other });
    const store = fakeQualifierStore([]);
    const http = fakeHttp({ [SITE]: { status: 404 }, [other]: PAGE });
    const r = await qualifyLead(snapshot({ nextStep: "p2", fields: [down, second] }), deps(store, http));
    expect(r.result).toBe("requeued");
    expect(steps(store)).toEqual(["p2:site_down:p2:"]);
    expect(store.log.find((l) => l[0] === "refute")![2]).toEqual([down.id]);
    // the next claim (fresh snapshot: the first is refuted) reads the other site
    const next = fakeQualifierStore([]);
    const r2 = await qualifyLead(snapshot({ nextStep: "p2", fields: [{ ...down, status: "refuted" }, second] }), deps(next, http));
    expect(r2.result).toBe("done");
    expect(http.calls).toContain(other);
    // a site that was not refuted (it came from the site itself) never loops
    const own = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p2", fields: [field({ field: "website", value: SITE, source: "site" }), second] }), deps(own, http));
    expect(steps(own)[0]).toBe("p2:site_down:p3:");
  });

  test("m-7: what P2 wrote counts for the level P3 sees", async () => {
    const store = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p2", level: 0, fields: [field({ field: "website", value: SITE })] }), deps(store));
    expect(steps(store)[1]).toBe("p3:skipped:p4:");
    const blocked = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p2", level: 0, fields: [field({ field: "website", value: SITE })] }), deps(blocked, fakeHttp({ [SITE]: { status: 403 } })));
    expect(steps(blocked)[1]).toBe("p3:places_off:p4:");
  });

  test("m-4/m-5: a value over 1000 characters is skipped, not cut; excerpts are cut on whole characters", async () => {
    const { factsToFields } = await import("@/lib/qualifier/site-facts");
    const { cut } = await import("@/lib/qualifier/site/extract");
    const found = (value: string, excerpt: string) => ({ value, url: SITE, excerpt });
    const empty = { name: null, phones: [], emails: [], address: null, city: null, state: null, zip: null, links: [], text: "" };
    const long = "x".repeat(1001);
    const read = { outcome: "ok" as const, finalHome: SITE, pages: [{ url: SITE, text: "", facts: { ...empty, address: found(long, "e"), city: found("Worcester", "😀".repeat(200)) } }] };
    const { add } = factsToFields(read, snapshot());
    expect(add.find((a) => a.field === "address")).toBeUndefined();
    const city = add.find((a) => a.field === "city")!;
    expect([...city.excerpt!].length).toBeLessThanOrEqual(300);
    expect(city.excerpt).not.toMatch(/[\ud800-\udbff]$/);
    expect(cut("a😀", 2)).toBe("a");
    expect(cut("ab", 5)).toBe("ab");
  });

  test("P1 that added values asks for a fresh pass; one that added nothing goes straight on", async () => {
    const a = fakeQualifierStore([], { merge: 2 });
    expect((await qualifyLead(snapshot(), deps(a))).result).toBe("requeued");
    expect(steps(a)).toEqual(["p1:ok:p2:"]);
    const b = fakeQualifierStore([], { merge: 0 });
    expect((await qualifyLead(snapshot(), deps(b))).result).toBe("done");
    expect(steps(b)[0]).toBe("p1:skipped:p2:");
  });

  test("three errors in a row on one step skip it with outcome error", async () => {
    const boom = Object.assign(new Error("rpc_down"), {});
    const store = fakeQualifierStore([], { failOn: { merge: boom } });
    // first and second failure: stay on p1 and give the lead back
    const one = await qualifyLead(snapshot(), deps(store));
    expect(one.result).toBe("requeued");
    expect(steps(store)).toEqual(["p1:error:p1:"]);
    // third: skipped with outcome error, the cascade goes on
    const third = fakeQualifierStore([], { failOn: { merge: boom } });
    const r = await qualifyLead(snapshot({ failStep: "p1", failStreak: 2 }), deps(third));
    expect(r.result).toBe("done");
    expect(steps(third)[0]).toBe("p1:error:p2:");
    expect(steps(third).at(-1)).toBe("p5:no_ai:done:complete");
  });

  test("a refused scheduler token is not a step error: it propagates", async () => {
    const auth = Object.assign(new Error("x"), { name: "HunterAuthError" });
    const store = fakeQualifierStore([], { failOn: { merge: auth } });
    await expect(qualifyLead(snapshot(), deps(store))).rejects.toBe(auth);
  });

  test("with an AI transport the AI steps are skipped for now, not no_ai", async () => {
    const store = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p4" }), deps(store, undefined, { transport: {} }));
    expect(steps(store)).toEqual(["p4:skipped:p5:", "p5:skipped:done:complete"]);
  });
});

// ---------------------------------------------------------------- P3 Places and P4 IA leve
const HIT: PlaceHit = { placeId: "pl_1", name: "Acme HVAC", address: "12 Main Street, Worcester, MA", phone: "(508) 555-0142", website: SITE, status: "OPERATIONAL" };
const places = (hit: PlaceHit | null) => {
  const calls: unknown[] = [];
  const client: PlacesClient = {
    async search(q) {
      calls.push(q);
      return hit;
    },
  };
  return { client, calls };
};
const NAME_ONLY = { name: "Acme HVAC", website: null, phone: null, city: "Worcester", state: "MA" };
const added = (store: { log: unknown[][] }) => store.log.filter((l) => l[0] === "addFields").flatMap((l) => l[2] as { field: string; value: string; source: string; status: string; source_ref?: string }[]);

describe("P3 Places", () => {
  test("P3 off without a key says places_off and the cascade goes on", async () => {
    const store = fakeQualifierStore([]);
    const r = await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY }), deps(store));
    expect(r.result).toBe("done");
    expect(steps(store)).toEqual(["p3:places_off:p4:", "p4:no_ai:p5:", "p5:no_ai:done:complete"]);
    expect(store.log.some((l) => l[0] === "reservePlaces")).toBe(false);
  });

  test("P3 stores only the place_id and values another source confirms (K-5); a found website is read by P2 in the same pass", async () => {
    const store = fakeQualifierStore([]);
    const http = fakeHttp({ [SITE]: PAGE });
    const p = places(HIT);
    const s = snapshot({ nextStep: "p3", best: NAME_ONLY, fields: [field({ field: "phone", value: "5085550142" })] });
    const r = await qualifyLead(s, deps(store, http, { places: p.client }));
    expect(r.result).toBe("done");
    expect(p.calls).toEqual([{ name: "Acme HVAC", city: "Worcester", state: "MA" }]);
    expect(store.log.find((l) => l[0] === "reservePlaces")!.slice(1)).toEqual(["lead-1", 0.04]);
    expect(store.log.find((l) => l[0] === "settlePlaces")!.slice(1)).toEqual(["lead-1", "res-1", 0.04, true]);
    const rows = added(store);
    expect(rows.find((a) => a.field === "place_id")).toMatchObject({ value: "pl_1", source: "places", status: "unverified" });
    // the phone is confirmed by a second source (the import already had it); the address is only Places' word: not stored from Places
    expect(rows.find((a) => a.field === "phone" && a.source === "places")).toMatchObject({ status: "confirmed" });
    expect(rows.some((a) => a.source === "places" && a.field === "address")).toBe(false);
    // the Places website is not stored (nobody else showed it), but the site was read and its own facts were kept
    expect(rows.some((a) => a.field === "website")).toBe(false);
    expect(http.calls).toContain(SITE);
    expect(rows.find((a) => a.field === "email")).toMatchObject({ value: "hello@acme-hvac.test", source: "site", source_ref: SITE });
    expect(steps(store)).toEqual(["p3:ok:p4:", "p4:no_ai:p5:", "p5:no_ai:done:complete"]);
  });

  test("P3: a closed place with nothing else to reach is dead; with a phone it goes on; level 2+ and a lead without a name skip it", async () => {
    const closed = { ...HIT, status: "CLOSED_PERMANENTLY" as const, website: null, phone: null };
    const dead = fakeQualifierStore([]);
    const r = await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY }), deps(dead, undefined, { places: places(closed).client }));
    expect(r.result).toBe("done");
    expect(steps(dead)).toEqual(["p3:closed:done:dead"]);
    expect(added(dead).find((a) => a.field === "place_id")).toBeTruthy();
    const alive = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY, fields: [field({ field: "phone", value: "5085550100" })] }), deps(alive, undefined, { places: places(closed).client }));
    expect(steps(alive)[0]).toBe("p3:closed:p4:");
    const lvl = places(HIT);
    const high = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p3", level: 2, best: NAME_ONLY }), deps(high, undefined, { places: lvl.client }));
    expect(steps(high)[0]).toBe("p3:skipped:p4:");
    await qualifyLead(snapshot({ nextStep: "p3", best: { ...NAME_ONLY, name: null } }), deps(fakeQualifierStore([]), undefined, { places: lvl.client }));
    expect(lvl.calls).toEqual([]);
  });

  test("P3: nothing found after a dead site is dead; nothing found otherwise is just ok", async () => {
    const http = fakeHttp({ [SITE]: { status: 404 } });
    const web = field({ field: "website", value: SITE });
    const dead = fakeQualifierStore([]);
    const r = await qualifyLead(snapshot({ nextStep: "p2", fields: [web], best: NAME_ONLY }), deps(dead, http, { places: places(null).client }));
    expect(r.result).toBe("done");
    expect(steps(dead)).toEqual(["p2:site_down:p3:", "p3:ok:done:dead"]);
    const plain = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY }), deps(plain, undefined, { places: places(null).client }));
    expect(steps(plain)[0]).toBe("p3:ok:p4:");
  });

  test("P3: a cap while reserving pauses or ends the lead; a failed call settles at zero and counts as a step error", async () => {
    const daily = fakeQualifierStore([], { failOn: { reservePlaces: new AiError("qualifier_daily") } });
    const r = await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY }), deps(daily, undefined, { places: places(HIT).client }));
    expect(r).toMatchObject({ result: "paused", pauseReason: "daily_cap" });
    expect(steps(daily)).toEqual([]);
    const cap = fakeQualifierStore([], { failOn: { reservePlaces: new AiError("lead_cap") } });
    const r2 = await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY }), deps(cap, undefined, { places: places(HIT).client }));
    expect(r2.result).toBe("done");
    expect(steps(cap)).toEqual(["p3:lead_cap:done:lead_cap"]);
    const boom = fakeQualifierStore([]);
    const failing: PlacesClient = { search: () => Promise.reject(Object.assign(new Error("places_http_500"), { status: 500 })) };
    const r3 = await qualifyLead(snapshot({ nextStep: "p3", best: NAME_ONLY }), deps(boom, undefined, { places: failing }));
    expect(r3).toMatchObject({ result: "requeued", errored: true });
    expect(boom.log.find((l) => l[0] === "settlePlaces")!.slice(1)).toEqual(["lead-1", "res-1", 0, false]);
    expect(steps(boom)).toEqual(["p3:error:p3:"]);
  });
});

describe("P4 IA leve", () => {
  const LIGHT = htmlPage(`<h1>Acme HVAC</h1><p>Pat Doe, President</p><a href="mailto:hello@acme-hvac.test">Mail</a>`);
  const aiLedger = (reserveError?: Error) => {
    const rows: string[] = [];
    const ledger: AiLedger = {
      dailyCapUsd: async () => 10,
      spentTodayUsd: async () => 0,
      record: async () => undefined,
      reserve: async (r) => {
        if (reserveError) throw reserveError;
        rows.push(`reserve:${r.task}`);
        return "c1";
      },
      settle: async () => {
        rows.push("settle");
      },
    };
    return { ledger, rows };
  };
  const model = (contacts: object[]) => new FakeTransport({ qualify_light: () => ({ json: { company_type: "builder", city: "", state: "", size_note: "", address: "", contacts } }) });
  const withSite = (p = SITE) => field({ field: "website", value: p });

  test("P4 runs only on pages read in this pass: the contact the page names is stored unverified with its URL; a made-up one is not", async () => {
    const t = model([{ name: "Pat Doe", title: "President", email: "", phone: "" }, { name: "Sam Invented", title: "CEO", email: "", phone: "" }]);
    const l = aiLedger();
    const store = fakeQualifierStore([], { ledger: l.ledger });
    const r = await qualifyLead(snapshot({ nextStep: "p2", fields: [withSite()] }), deps(store, fakeHttp({ [SITE]: LIGHT }), { transport: t }));
    expect(r.result).toBe("done");
    expect(steps(store).slice(0, 3)).toEqual(["p2:ok:p3:", "p3:places_off:p4:", "p4:ok:p5:"]);
    const ai = added(store).filter((a) => a.source === "ai");
    expect(ai.find((a) => a.field === "contact_name")).toMatchObject({ value: "Pat Doe", status: "unverified", source_ref: SITE });
    expect(ai.find((a) => a.field === "contact_title")).toMatchObject({ value: "President" });
    expect(ai.find((a) => a.field === "company_type")).toMatchObject({ value: "builder", status: "unverified" });
    expect(ai.some((a) => /Sam/.test(a.value))).toBe(false);
    expect(l.rows).toEqual(["reserve:qualify_light", "settle"]);
    expect(t.calls).toHaveLength(1);
    // a pass that read no page does not call the model
    const t2 = model([]);
    const none = fakeQualifierStore([], { ledger: aiLedger().ledger });
    await qualifyLead(snapshot({ nextStep: "p4", fields: [withSite()] }), deps(none, undefined, { transport: t2 }));
    expect(steps(none)[0]).toBe("p4:skipped:p5:");
    expect(t2.calls).toHaveLength(0);
  });

  test("P4 without AI says no_ai", async () => {
    const store = fakeQualifierStore([]);
    await qualifyLead(snapshot({ nextStep: "p2", fields: [withSite()] }), deps(store, fakeHttp({ [SITE]: LIGHT })));
    expect(steps(store)[2]).toBe("p4:no_ai:p5:");
  });

  test("P4: qualifier_daily pauses the lead with nothing written for the step; lead_cap ends the lead", async () => {
    const daily = fakeQualifierStore([], { ledger: aiLedger(new AiError("qualifier_daily")).ledger });
    const r = await qualifyLead(snapshot({ nextStep: "p2", fields: [withSite()] }), deps(daily, fakeHttp({ [SITE]: LIGHT }), { transport: model([]) }));
    expect(r).toMatchObject({ result: "paused", pauseReason: "daily_cap" });
    expect(steps(daily)).toEqual(["p2:ok:p3:", "p3:places_off:p4:"]);
    const lead = fakeQualifierStore([], { ledger: aiLedger(new AiError("lead_cap")).ledger });
    const r2 = await qualifyLead(snapshot({ nextStep: "p2", fields: [withSite()] }), deps(lead, fakeHttp({ [SITE]: LIGHT }), { transport: model([]) }));
    expect(r2.result).toBe("done");
    expect(steps(lead).at(-1)).toBe("p4:lead_cap:done:lead_cap");
    for (const [code, reason] of [["daily_cap", "workspace_cap"], ["user_cap", "user_cap"], ["global_cap", "global_cap"], ["no_access", "no_access"]] as const) {
      const st = fakeQualifierStore([], { ledger: aiLedger(new AiError(code)).ledger });
      const x = await qualifyLead(snapshot({ nextStep: "p2", fields: [withSite()] }), deps(st, fakeHttp({ [SITE]: LIGHT }), { transport: model([]) }));
      expect(x).toMatchObject({ result: "paused", pauseReason: reason });
    }
  });
});
