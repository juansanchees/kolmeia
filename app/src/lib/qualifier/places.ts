import "server-only";
import { getPlacesKey } from "./places-config";
import type { PlaceHit, PlacesClient } from "./types";

// P3: Google Places Text Search (New), one call per lead, the smallest field mask. Errors carry the HTTP status only:
// never the key, a request body or a response body (R10).

export const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
export const PLACES_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.businessStatus";
/** US$ reserved and settled per HTTP-200 call. "?": read Google's current price and terms before the key is set, then adjust. */
export const PLACES_CALL_USD = 0.04;
const TIMEOUT_MS = 5000;
const STATUSES = new Set(["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"]);

export class PlacesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function googlePlacesClient(key: string, fetchImpl: typeof fetch = fetch): PlacesClient {
  return {
    async search(q) {
      const textQuery = [q.name, q.city, q.state ?? "MA"].filter(Boolean).join(" ");
      let res: Response;
      try {
        res = await fetchImpl(PLACES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": PLACES_FIELD_MASK },
          body: JSON.stringify({ textQuery, pageSize: 1, regionCode: "US" }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new PlacesError("places_network", 0);
      }
      if (res.status !== 200) throw new PlacesError(`places_http_${res.status}`, res.status);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new PlacesError("places_bad_json", 200);
      }
      const places = (json as { places?: unknown })?.places;
      const p = Array.isArray(places) ? (places[0] as Record<string, unknown> | undefined) : undefined;
      const id = str(p?.id);
      if (!p || !id) return null;
      const status = str(p.businessStatus);
      const hit: PlaceHit = {
        placeId: id,
        name: str((p.displayName as { text?: unknown } | undefined)?.text),
        address: str(p.formattedAddress),
        phone: str(p.nationalPhoneNumber),
        website: str(p.websiteUri),
        status: status && STATUSES.has(status) ? (status as PlaceHit["status"]) : null,
      };
      return hit;
    },
  };
}

/** The real client, or null when no key is set. */
export function placesClient(): PlacesClient | null {
  const key = getPlacesKey();
  return key ? googlePlacesClient(key) : null;
}
