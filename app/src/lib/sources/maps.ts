// Google Maps (Apify compass~crawler-google-places): input builder and place mapping. Pure.
import { nameKey, phoneKey } from "@/lib/research/dedupe";
import { sanitizeUrl } from "@/lib/safe-url";
import type { ImportRowIn } from "./types";

export const MAPS_ACTOR = "compass~crawler-google-places";
/** Estimated price per place (?): only used to reserve; the real cost comes back from the run. */
export const MAPS_USD_PER_PLACE = 0.004;
/** Apify rejects a run whose max charge is below this. */
export const APIFY_MIN_CHARGE_USD = 0.5;

/** max(0.50, max x 0.004 rounded up to the cent). */
export function mapsReserve(max: number): number {
  return Math.max(APIFY_MIN_CHARGE_USD, Math.ceil(Math.round(max * MAPS_USD_PER_PLACE * 1e6) / 1e4) / 100);
}

export function mapsInput(q: { terms: string[]; location: string; max: number }): object {
  return {
    searchStringsArray: q.terms,
    locationQuery: q.location,
    maxCrawledPlacesPerSearch: Math.ceil(q.max / Math.max(1, q.terms.length)),
    language: "en",
    skipClosedPlaces: true,
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
  };
}

const str = (v: unknown, cap: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, cap) : undefined;
};

/** null = dropped (not US, permanently closed, no name). Blocked hosts (social profiles that rule R11 bans) are dropped as a field by sanitizeUrl. */
export function mapPlace(item: unknown, row = 1): ImportRowIn | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const p = item as Record<string, unknown>;
  if (p.permanentlyClosed === true) return null;
  // A missing or empty countryCode is kept on purpose: the actor usually sends one, and dropping the place for a blank field would lose real US results. Only a known non-US code drops it.
  const cc = typeof p.countryCode === "string" ? p.countryCode.trim() : "";
  if (cc && cc.toUpperCase() !== "US") return null;
  const name = str(p.title, 200);
  if (!name) return null;
  const nk = nameKey(name);
  if (!nk) return null;

  const out: ImportRowIn = { row, name, name_key: nk };
  const website = sanitizeUrl(p.website);
  if (website && website.length <= 300) out.website = website;
  const phone = str(p.phone, 300) ?? str(p.phoneUnformatted, 300);
  if (phone && phoneKey(phone)) out.phone = phone;
  const address = str(p.street, 300) ?? str(p.address, 300);
  if (address) out.address = address;
  const city = str(p.city, 300);
  if (city) out.city = city;
  const state = str(p.state, 300);
  if (state) out.state = state;
  const zip = str(p.postalCode, 300);
  if (zip) out.zip = zip;
  const placeId = str(p.placeId, 300);
  if (placeId) out.place_id = placeId;
  const category = str(p.categoryName, 300);
  if (category) out.company_type = category;
  return out;
}
