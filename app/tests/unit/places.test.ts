import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { googlePlacesClient, placesClient, PlacesError, PLACES_FIELD_MASK, PLACES_URL, PLACES_CALL_USD } = await import("@/lib/qualifier/places");
const { hasPlaces } = await import("@/lib/qualifier/places-config");

const KEY = "test-key-not-real-123";
const body = (places: unknown[]) => JSON.stringify({ places });

function fakeFetch(status: number, text: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(text, { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("P3 Places client", () => {
  test("no key: no client, and the step is off", () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    expect(placesClient()).toBeNull();
    expect(hasPlaces()).toBe(false);
    vi.stubEnv("GOOGLE_PLACES_API_KEY", KEY);
    expect(placesClient()).not.toBeNull();
    expect(hasPlaces()).toBe(true);
    vi.unstubAllEnvs();
  });

  test("one POST with the field mask, the key header, pageSize 1; a non-200 throws PlacesError without the key in the message", async () => {
    const ok = fakeFetch(200, body([]));
    await googlePlacesClient(KEY, ok.impl).search({ name: "Acme HVAC", city: "Worcester", state: null });
    expect(ok.calls).toHaveLength(1);
    const c = ok.calls[0];
    expect(c.url).toBe(PLACES_URL);
    expect(c.init.method).toBe("POST");
    const h = c.init.headers as Record<string, string>;
    expect(h["X-Goog-Api-Key"]).toBe(KEY);
    expect(h["X-Goog-FieldMask"]).toBe(PLACES_FIELD_MASK);
    expect(JSON.parse(String(c.init.body))).toEqual({ textQuery: "Acme HVAC Worcester MA", pageSize: 1, regionCode: "US" });
    expect(PLACES_CALL_USD).toBe(0.04);

    const bad = fakeFetch(403, `{"error":"key ${KEY} refused"}`);
    const err = await googlePlacesClient(KEY, bad.impl).search({ name: "Acme", city: null, state: "MA" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlacesError);
    expect(err.status).toBe(403);
    expect(String(err.message)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    const down = await googlePlacesClient(KEY, (async () => { throw new Error(`boom ${KEY}`); }) as typeof fetch).search({ name: "A", city: null, state: null }).catch((e) => e);
    expect(down).toBeInstanceOf(PlacesError);
    expect(String(down.message)).not.toContain(KEY);
  });

  test("the hit keeps id, name, address, phone, website and status", async () => {
    const f = fakeFetch(
      200,
      body([{ id: "pl_1", displayName: { text: "Acme HVAC" }, formattedAddress: "12 Main St, Worcester, MA", nationalPhoneNumber: "(508) 555-0142", websiteUri: "https://acme-hvac.test/", businessStatus: "OPERATIONAL" }]),
    );
    const hit = await googlePlacesClient(KEY, f.impl).search({ name: "Acme HVAC", city: "Worcester", state: "MA" });
    expect(hit).toEqual({ placeId: "pl_1", name: "Acme HVAC", address: "12 Main St, Worcester, MA", phone: "(508) 555-0142", website: "https://acme-hvac.test/", status: "OPERATIONAL" });
    expect(await googlePlacesClient(KEY, fakeFetch(200, body([{ id: "x", businessStatus: "WEIRD" }])).impl).search({ name: "A", city: null, state: null })).toMatchObject({ placeId: "x", status: null });
    expect(await googlePlacesClient(KEY, fakeFetch(200, "{}").impl).search({ name: "A", city: null, state: null })).toBeNull();
  });
});
