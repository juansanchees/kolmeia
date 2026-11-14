import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { qualifyLead } = await import("@/lib/qualifier/cascade");
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
