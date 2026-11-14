import { describe, expect, it } from "vitest";
import { ApifyError, apifyClient } from "@/lib/sources/apify";
import { SourceHttpError } from "@/lib/sources/http";
import { MAPS_ACTOR, mapPlace, mapsInput, mapsReserve } from "@/lib/sources/maps";
import { fakeHttp } from "./sources-fakes";

const TOKEN = "apify_api_TEST";
const B = "https://api.apify.com/v2";

describe("mapsReserve", () => {
  it("50 -> 0.50, 200 -> 0.80, 1 -> 0.50", () => {
    expect(mapsReserve(50)).toBe(0.5);
    expect(mapsReserve(200)).toBe(0.8);
    expect(mapsReserve(1)).toBe(0.5);
  });
  it("rounds up to the cent above the minimum", () => {
    expect(mapsReserve(201)).toBe(0.81);
    expect(mapsReserve(1000)).toBe(4);
  });
});

describe("mapsInput", () => {
  it("fixes the spec values and splits max across terms", () => {
    const i = mapsInput({ terms: ["general contractor", "builder", "developer"], location: "Worcester, MA", max: 50 });
    expect(i).toEqual({
      searchStringsArray: ["general contractor", "builder", "developer"],
      locationQuery: "Worcester, MA",
      maxCrawledPlacesPerSearch: 17,
      language: "en",
      skipClosedPlaces: true,
      scrapePlaceDetailPage: false,
      scrapeContacts: false,
    });
    expect((mapsInput({ terms: ["a"], location: "x", max: 50 }) as { maxCrawledPlacesPerSearch: number }).maxCrawledPlacesPerSearch).toBe(50);
  });
});

describe("apify client", () => {
  it("start sends the token only in the Authorization header and passes maxTotalChargeUsd and timeout", async () => {
    const http = fakeHttp({ [`POST ${B}/acts/`]: { status: 201, json: { data: { id: "run1", defaultDatasetId: "ds1" } } } });
    const r = await apifyClient(TOKEN, http).start(MAPS_ACTOR, { a: 1 }, 0.5);
    expect(r).toEqual({ runId: "run1", datasetId: "ds1" });
    const c = http.calls[0];
    expect(c.url).toBe(`${B}/acts/compass~crawler-google-places/runs?maxTotalChargeUsd=0.5&timeout=600`);
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.url).not.toContain(TOKEN);
    expect(JSON.stringify(c.body)).not.toContain(TOKEN);
    expect(c.body).toEqual({ a: 1 });
  });

  it("status reads usageTotalUsd or null", async () => {
    const http = fakeHttp({
      [`GET ${B}/actor-runs/r1`]: { status: 200, json: { data: { status: "SUCCEEDED", usageTotalUsd: 0.63 } } },
      [`GET ${B}/actor-runs/r2`]: { status: 200, json: { data: { status: "RUNNING" } } },
    });
    const c = apifyClient(TOKEN, http);
    expect(await c.status("r1")).toEqual({ status: "SUCCEEDED", usageUsd: 0.63 });
    expect(await c.status("r2")).toEqual({ status: "RUNNING", usageUsd: null });
  });

  it("items, abort and checkKey use the documented endpoints", async () => {
    const http = fakeHttp({
      [`GET ${B}/datasets/ds1/items`]: { status: 200, json: [{ title: "A" }] },
      [`POST ${B}/actor-runs/r1/abort`]: { status: 200, json: { data: {} } },
      [`GET ${B}/users/me`]: { status: 200, json: { data: {} } },
    });
    const c = apifyClient(TOKEN, http);
    expect(await c.items("ds1", 50)).toEqual([{ title: "A" }]);
    expect(http.calls[0].url).toBe(`${B}/datasets/ds1/items?clean=true&format=json&limit=50`);
    await c.abort("r1");
    expect(await c.checkKey()).toBe("ok");
  });

  it("checkKey tells refused from unreachable", async () => {
    expect(await apifyClient(TOKEN, fakeHttp({ [`GET ${B}/users/me`]: { status: 401, json: { error: { message: TOKEN } } } })).checkKey()).toBe("refused");
    expect(await apifyClient(TOKEN, fakeHttp({ [`GET ${B}/users/me`]: { status: 503, json: null } })).checkKey()).toBe("unreachable");
    expect(await apifyClient(TOKEN, fakeHttp({ [`GET ${B}/users/me`]: new SourceHttpError("timeout") })).checkKey()).toBe("unreachable");
  });

  it("apify errors never contain the token", async () => {
    const echo = { error: { message: `bad ${TOKEN}`, request: { headers: { Authorization: `Bearer ${TOKEN}` } } } };
    const cases: Record<string, { status: number; json: unknown } | Error>[] = [
      { [`GET ${B}/actor-runs/`]: { status: 401, json: echo } },
      { [`GET ${B}/actor-runs/`]: { status: 500, json: echo } },
      { [`GET ${B}/actor-runs/`]: new Error(`connect failed Authorization: Bearer ${TOKEN}`) },
      { [`GET ${B}/actor-runs/`]: new SourceHttpError("bad_json") },
      { [`GET ${B}/actor-runs/`]: { status: 200, json: { data: { status: "WEIRD" } } } },
    ];
    const seen: string[] = [];
    for (const routes of cases) {
      let err: unknown;
      try {
        await apifyClient(TOKEN, fakeHttp(routes)).status("r1");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const e = err as Error;
      expect(`${e.name} ${e.message} ${e.stack ?? ""}`).not.toContain(TOKEN);
      seen.push(e.message);
    }
    expect(seen).toEqual(["apify_refused", "apify_http_500", "source_http_network", "source_http_bad_json", "apify_bad_response"]);
    expect(new ApifyError("http_500").code).toBe("http_500");
  });
});

describe("mapPlace", () => {
  const full = {
    title: "Cutler Brothers Construction",
    categoryName: "General contractor",
    phone: "(508) 555-0142",
    phoneUnformatted: "+15085550142",
    website: "https://cutler.example/",
    address: "1 Main St, Worcester, MA 01608",
    street: "1 Main St",
    city: "Worcester",
    state: "Massachusetts",
    postalCode: "01608",
    countryCode: "US",
    placeId: "ChIJ_TEST_1",
    permanentlyClosed: false,
  };

  it("maps title, phone, website, address, zip, place_id, category", () => {
    expect(mapPlace(full, 3)).toEqual({
      row: 3,
      name: "Cutler Brothers Construction",
      name_key: "cutler brothers construction",
      website: "https://cutler.example/",
      phone: "(508) 555-0142",
      address: "1 Main St",
      city: "Worcester",
      state: "Massachusetts",
      zip: "01608",
      place_id: "ChIJ_TEST_1",
      company_type: "General contractor",
    });
  });

  it("falls back to the full address and to the unformatted phone", () => {
    const r = mapPlace({ ...full, street: undefined, phone: undefined });
    expect(r?.address).toBe(full.address);
    expect(r?.phone).toBe("+15085550142");
  });

  it("drops non-US, closed, nameless; strips LinkedIn", () => {
    expect(mapPlace({ ...full, countryCode: "CA" })).toBeNull();
    expect(mapPlace({ ...full, permanentlyClosed: true })).toBeNull();
    expect(mapPlace({ ...full, title: "  " })).toBeNull();
    expect(mapPlace({ ...full, title: undefined })).toBeNull();
    expect(mapPlace(null)).toBeNull();
    expect(mapPlace("x")).toBeNull();
    const li = mapPlace({ ...full, website: "https://www.linkedin.com/company/cutler" });
    expect(li).not.toBeNull();
    expect(li).not.toHaveProperty("website");
  });

  it("omits an unusable phone instead of importing it", () => {
    expect(mapPlace({ ...full, phone: "n/a", phoneUnformatted: "" })).not.toHaveProperty("phone");
  });
});
