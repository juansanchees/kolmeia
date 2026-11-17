import { describe, expect, test } from "vitest";
import { mapContractor, permitWindow, placeQuery, shovelsClient, ShovelsError, shovelsSize } from "@/lib/sources/shovels";
import { SourceHttpError } from "@/lib/sources/http";
import { fakeHttp } from "./sources-fakes";

// Shovels adapter: fictional contractors only, no network. The key below is a made-up test value.
const KEY = "shovels_TESTKEY_0000";
const S = "https://api.shovels.ai/v2";

const item = (o: Record<string, unknown> = {}) => ({
  id: "c1",
  license: "123456",
  name: "ACME BUILDERS LLC",
  business_name: "Acme Builders LLC",
  primary_phone: "(508) 555-0101",
  phone: "(508) 555-0101,(508) 555-0102",
  primary_email: "office@acme-builders.example",
  email: "office@acme-builders.example,info@acme-builders.example",
  website: "acme-builders.example",
  primary_industry: "General Contractor",
  status_tally: { active: 3, final: 10 },
  tag_tally: { hvac: 2, new_construction: 5, solar: 1, roofing: 0, "Bad Tag!": 9 },
  total_job_value: 172_500_000,
  address: { street_no: "12", street: "MAIN ST", city: "WORCESTER", state: "MA", zip_code: "01608" },
  ...o,
});

describe("mapContractor", () => {
  test("maps a contractor to an import row with a short note", () => {
    expect(mapContractor(item(), 7)).toEqual({
      row: 7,
      name: "Acme Builders LLC",
      name_key: expect.any(String),
      phone: "(508) 555-0101",
      email: "office@acme-builders.example",
      website: "https://acme-builders.example/",
      address: "12 MAIN ST",
      city: "WORCESTER",
      state: "MA",
      zip: "01608",
      company_type: "General Contractor",
      note: "Shovels: 3 alvarás ativos (12 meses) · valor total das obras US$ 1.725.000 · tipos: new construction, hvac, solar · licença 123456",
    });
  });

  test("no usable name drops the row; wrong-typed fields drop only the field", () => {
    expect(mapContractor({ name: "", business_name: "  " })).toBeNull();
    expect(mapContractor(null)).toBeNull();
    expect(mapContractor("x")).toBeNull();
    const r = mapContractor(item({ primary_phone: 5, phone: "123", total_job_value: "lots", status_tally: "x", tag_tally: null, address: 3 }));
    expect(r?.name).toBe("Acme Builders LLC");
    expect(r?.phone).toBeUndefined(); // "123" is not a phone
    expect(r?.city).toBeUndefined();
    expect(r?.note).toBe("Shovels: ? alvarás ativos (12 meses) · licença 123456");
  });

  test("bad and social URLs are dropped; a bare domain gets https://", () => {
    for (const bad of ["javascript:alert(1)", "http://127.0.0.1/x", "https://user:pw@acme.example", "https://www.linkedin.com/company/acme", "not a url"]) {
      expect(mapContractor(item({ website: bad }))?.website, bad).toBeUndefined();
    }
    expect(mapContractor(item({ website: "http://acme.example/" }))?.website).toBe("http://acme.example/");
  });

  test("strings are capped: name 200, fields 300, note 1000; junk e-mails skipped for the next one", () => {
    const r = mapContractor(item({ business_name: "B".repeat(500), address: { city: "C".repeat(500) }, license: "L".repeat(500), primary_email: "x@example.com" }));
    expect(r?.name).toHaveLength(200);
    expect(r?.city).toHaveLength(300);
    expect(r!.note!.length).toBeLessThanOrEqual(1000);
    expect(r?.email).toBe("office@acme-builders.example");
  });
});

describe("budget and places", () => {
  test("never more than asked, one page (100) or the credits left", () => {
    expect(shovelsSize(50, { used: 0, limit: 500 })).toBe(50);
    expect(shovelsSize(50, { used: 480, limit: 500 })).toBe(20);
    expect(shovelsSize(50, { used: 500, limit: 500 })).toBe(0);
    expect(shovelsSize(50, { used: 900, limit: 500 })).toBe(0);
    expect(shovelsSize(300, { used: 0, limit: null })).toBe(100);
    expect(shovelsSize(0, { used: 0, limit: 500 })).toBe(0);
  });

  test("permit window is the last 365 days", () => {
    expect(permitWindow(Date.parse("2026-11-16T12:00:00Z"))).toEqual({ from: "2025-11-16", to: "2026-11-16" });
  });

  test("MA only: state, MA ZIP, county, city; other ZIPs and junk are refused", () => {
    expect(placeQuery("")).toEqual({ geoId: "MA" });
    expect(placeQuery("Massachusetts")).toEqual({ geoId: "MA" });
    expect(placeQuery("01602")).toEqual({ geoId: "01602" });
    expect(placeQuery("02139, MA")).toEqual({ geoId: "02139" });
    expect(placeQuery("90210")).toBeNull();
    expect(placeQuery("Worcester, MA")).toEqual({ lookup: "cities", q: "Worcester" });
    expect(placeQuery("Middlesex County")).toEqual({ lookup: "counties", q: "Middlesex County" });
    expect(placeQuery("a&b=c")).toBeNull();
  });
});

describe("shovelsClient", () => {
  test("checkKey: 200 ok, 401/403 refused, network or 5xx unreachable; key only in the header", async () => {
    const at = (r: { status: number; json: unknown } | Error) => shovelsClient(KEY, fakeHttp({ [`GET ${S}/usage`]: r })).checkKey();
    expect(await at({ status: 200, json: { credits_used: 10, credit_limit: 500 } })).toBe("ok");
    expect(await at({ status: 401, json: { detail: "bad" } })).toBe("refused");
    expect(await at({ status: 403, json: {} })).toBe("refused");
    expect(await at(new SourceHttpError("network"))).toBe("unreachable");
    expect(await at({ status: 500, json: null })).toBe("unreachable");
    expect(await at({ status: 200, json: { nope: 1 } })).toBe("unreachable");
    const http = fakeHttp({ [`GET ${S}/usage`]: { status: 200, json: { credits_used: 0, credit_limit: null } } });
    await shovelsClient(KEY, http).checkKey();
    expect(http.calls[0].headers["X-API-Key"]).toBe(KEY);
    expect(http.calls[0].url).not.toContain(KEY);
  });

  test("resolvePlace: ZIP and state need no call; a city picks the exact MA match", async () => {
    const http = fakeHttp({
      [`GET ${S}/cities/search?q=Worcester`]: {
        status: 200,
        json: { items: [{ geo_id: "abcNY", name: "WORCESTER, OTSEGO COUNTY, NY", state: "NY" }, { geo_id: "x1", name: "WEST WORCESTER, MA", state: "MA" }, { geo_id: "w1", name: "WORCESTER, WORCESTER COUNTY, MA", state: "MA" }] },
      },
      [`GET ${S}/cities/search?q=Nowhere`]: { status: 404, json: { detail: "not found" } },
    });
    const c = shovelsClient(KEY, http);
    expect(await c.resolvePlace("01602")).toBe("01602");
    expect(await c.resolvePlace("MA")).toBe("MA");
    expect(http.calls).toHaveLength(0);
    expect(await c.resolvePlace("Worcester")).toBe("w1");
    expect(await c.resolvePlace("Nowhere")).toBeNull();
    expect(await c.resolvePlace("90210")).toBeNull();
  });

  test("contractors: active permits, window, tag and size in the query; 402 is a credits error", async () => {
    const http = fakeHttp({ [`GET ${S}/contractors/search`]: { status: 200, json: { items: [item(), item()], size: 2, next_cursor: null } } });
    const items = await shovelsClient(KEY, http).contractors({ geoId: "MA", tag: "hvac", size: 1, from: "2025-11-16", to: "2026-11-16" });
    expect(items).toHaveLength(1); // never more than asked, even if the service sends more
    const u = new URL(http.calls[0].url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ geo_id: "MA", permit_from: "2025-11-16", permit_to: "2026-11-16", permit_status: "active", size: "1", permit_tags: "hvac" });
    const all = fakeHttp({ [`GET ${S}/contractors/search`]: { status: 200, json: { items: [] } } });
    await shovelsClient(KEY, all).contractors({ geoId: "MA", tag: "all", size: 5, from: "a", to: "b" });
    expect(all.calls[0].url).not.toContain("permit_tags");
    const broke = fakeHttp({ [`GET ${S}/contractors/search`]: { status: 402, json: { detail: { error: "Monthly credit limit exceeded." } } } });
    await expect(shovelsClient(KEY, broke).contractors({ geoId: "MA", tag: "all", size: 5, from: "a", to: "b" })).rejects.toMatchObject({ code: "credits" });
    const err = await shovelsClient(KEY, fakeHttp({ [`GET ${S}/usage`]: new Error(`echo ${KEY}`) })).usage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShovelsError);
    expect(String((err as Error).message)).not.toContain(KEY);
  });
});
