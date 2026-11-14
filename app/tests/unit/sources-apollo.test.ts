import { describe, expect, it } from "vitest";
import {
  apolloClient, ApolloError, ApolloKeyError, ApolloPlanError, isForeignDomain, mapOrg,
} from "@/lib/sources/apollo";
import type { HttpJson } from "@/lib/sources/http";
import { mapPlace } from "@/lib/sources/maps";

const KEY = "apollo_TEST";
const Q = { locations: [] as string[], naics: [] as string[], page: 1 };
function fake(res: { status?: number; json: unknown } | Error) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const http: HttpJson = {
    async request(method, url, o) {
      calls.push({ method, url, headers: o.headers, body: o.body });
      if (res instanceof Error) throw res;
      return { status: res.status ?? 200, json: res.json };
    },
  };
  return { http, calls };
}

describe("apolloClient.lookup", () => {
  it("sends display_mode fuzzy_select_mode, locations, naics, page and per_page 25, key only in the header", async () => {
    const { http, calls } = fake({ json: { organizations: [{ name: "Acme Heating", primary_domain: "acme.example" }] } });
    const out = await apolloClient(KEY, http).lookup({ locations: ["Massachusetts, US"], naics: ["238220"], page: 2 });
    expect(out).toHaveLength(1);
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(c.headers["X-Api-Key"]).toBe(KEY);
    expect(c.url).not.toContain(KEY);
    expect(JSON.stringify(c.body)).not.toContain(KEY);
    expect(c.body).toEqual({
      display_mode: "fuzzy_select_mode", organization_locations: ["Massachusetts, US"],
      organization_naics_codes: ["238220"], page: 2, per_page: 25,
    });
  });
  it("reads either list key and tolerates an odd body", async () => {
    expect(await apolloClient(KEY, fake({ json: { accounts: [{ name: "A" }] } }).http).lookup(Q)).toHaveLength(1);
    expect(await apolloClient(KEY, fake({ json: "nope" }).http).lookup(Q)).toEqual([]);
  });
  it("lookup never calls an enrich endpoint", async () => {
    const { http, calls } = fake({ json: { organizations: [] } });
    await apolloClient(KEY, http).lookup(Q);
    await apolloClient(KEY, http).checkKey();
    for (const c of calls) expect(c.url).not.toMatch(/enrich|people|match/);
    expect(calls[0].url).toContain("/mixed_companies/search");
  });
});

describe("apolloClient errors", () => {
  it("plan-blocked endpoint gives the Portuguese plan error", async () => {
    const { http } = fake({ status: 403, json: { error: "not included in your Free plan", error_code: "API_INACCESSIBLE" } });
    const err = await apolloClient(KEY, http).lookup(Q).catch((e) => e);
    expect(err).toBeInstanceOf(ApolloPlanError);
    expect(err.message).toBe("Seu plano do Apollo não libera esta busca pela API");
  });
  it("401 is a key error and no error carries the key", async () => {
    const e1 = await apolloClient(KEY, fake({ status: 401, json: { echo: KEY } }).http).checkKey().catch((e) => e);
    expect(e1).toBeInstanceOf(ApolloKeyError);
    const e2 = await apolloClient(KEY, fake(new Error(`boom X-Api-Key: ${KEY}`)).http).lookup(Q).catch((e) => e);
    expect(e2).toBeInstanceOf(ApolloError);
    const e3 = await apolloClient(KEY, fake({ status: 500, json: { echo: KEY } }).http).lookup(Q).catch((e) => e);
    expect(e3).toBeInstanceOf(ApolloError);
    for (const e of [e1, e2, e3]) expect(String(e.message) + String(e.stack ?? "")).not.toContain(KEY);
  });
  it("checkKey is true on 200", async () => {
    expect(await apolloClient(KEY, fake({ json: { healthy: true } }).http).checkKey()).toBe(true);
  });
});

describe("apollo junk filter", () => {
  it("drops foreign ccTLDs and domainless rows", () => {
    expect(isForeignDomain("acme.co.uk")).toBe(true);
    expect(isForeignDomain("x.com.pk")).toBe(true);
    expect(isForeignDomain("y.ca")).toBe(true);
    expect(isForeignDomain("z.com")).toBe(false);
    expect(isForeignDomain("w.us")).toBe(false);
    for (const ok of ["acme.io", "acme.ai", "acme.co", "ACME.IO."]) expect(isForeignDomain(ok)).toBe(false);
    for (const bad of ["acme.de", "acme.in", "acme.co.uk"]) expect(isForeignDomain(bad)).toBe(true);
    expect(mapOrg({ name: "Dot Io", primary_domain: "dotio.io" })?.website).toBe("https://dotio.io/");
    expect(mapOrg({ name: "Dot De", primary_domain: "dotde.de" })).toBeNull();
    expect(mapOrg({ name: "A", primary_domain: "acme.co.uk" })).toBeNull();
    expect(mapOrg({ name: "B", domain: "x.com.pk", website_url: "http://www.x.com.pk" })).toBeNull();
    expect(mapOrg({ name: "C", primary_domain: "y.ca" })).toBeNull();
    expect(mapOrg({ name: "D" })).toBeNull();
    expect(mapOrg({ name: "D", website_url: "" })).toBeNull();
    expect(mapOrg({ name: "", primary_domain: "z.com" })).toBeNull();
    expect(mapOrg(null)).toBeNull();
    expect(mapOrg({ name: "E", primary_domain: "z.com" })).toEqual({ row: 1, name: "E", name_key: "e", website: "https://z.com/" });
    expect(mapOrg({ name: "F", primary_domain: "w.us" })).toEqual({ row: 1, name: "F", name_key: "f", website: "https://w.us/" });
  });
  it("mapOrg prefers website_url, strips LinkedIn and keeps no phone", () => {
    const r = mapOrg({
      name: "Acme", primary_domain: "acme.example", website_url: "https://www.acme.example/hvac",
      phone: "508-555-0101", primary_phone: { number: "508-555-0101" }, linkedin_url: "https://linkedin.com/company/acme",
    });
    expect(r).toEqual({ row: 1, name: "Acme", name_key: "acme", website: "https://www.acme.example/hvac" });
    expect(JSON.stringify(r)).not.toMatch(/555|linkedin/i);
    expect(mapOrg({ name: "Beta", primary_domain: "beta.example", website_url: "https://linkedin.com/company/beta" }))
      .toEqual({ row: 1, name: "Beta", name_key: "beta", website: "https://beta.example/" });
  });
});

describe("row keys match import_rows_core", () => {
  // import_rows_core (0013) accepts: row, name, name_key + website, phone, email, address, city, state, zip, contact_name, contact_title, note
  // and, for source imports only, company_type and place_id. name_key is required.
  const ALLOWED = new Set(["row", "name", "name_key", "website", "phone", "email", "address", "city", "state", "zip", "contact_name", "contact_title", "note", "company_type", "place_id"]);
  it("mapOrg emits only accepted keys, with row and name_key", () => {
    const r = mapOrg({ name: "Acme Heating", primary_domain: "acme.example" }, 7)!;
    expect(Object.keys(r).sort()).toEqual(["name", "name_key", "row", "website"]);
    expect(r.row).toBe(7);
    for (const k of Object.keys(r)) expect(ALLOWED.has(k)).toBe(true);
  });
  it("mapPlace emits only accepted keys", () => {
    const r = mapPlace({ title: "Cutler Builders", website: "https://cutler.example", phone: "(508) 555-0101", street: "1 Main St", city: "Worcester", state: "MA", postalCode: "01608", placeId: "ChIJfake", categoryName: "General contractor", countryCode: "US" }, 3)!;
    expect(Object.keys(r).sort()).toEqual(["address", "city", "company_type", "name", "name_key", "phone", "place_id", "row", "state", "website", "zip"]);
    for (const k of Object.keys(r)) expect(ALLOWED.has(k)).toBe(true);
  });
});
