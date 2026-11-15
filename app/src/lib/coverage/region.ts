// Client-safe: turns place text into canonical Massachusetts town names.
import { MA_TOWNS, type MaCounty } from "./ma-towns";

export const REGION_ALIASES: Record<string, MaCounty> = { "cape cod": "Barnstable", cape: "Barnstable" };

export const OTHER_STATES: readonly { name: string; code: string }[] = [
  { name: "Alabama", code: "AL" },
  { name: "Alaska", code: "AK" },
  { name: "Arizona", code: "AZ" },
  { name: "Arkansas", code: "AR" },
  { name: "California", code: "CA" },
  { name: "Colorado", code: "CO" },
  { name: "Connecticut", code: "CT" },
  { name: "Delaware", code: "DE" },
  { name: "Florida", code: "FL" },
  { name: "Georgia", code: "GA" },
  { name: "Hawaii", code: "HI" },
  { name: "Idaho", code: "ID" },
  { name: "Illinois", code: "IL" },
  { name: "Indiana", code: "IN" },
  { name: "Iowa", code: "IA" },
  { name: "Kansas", code: "KS" },
  { name: "Kentucky", code: "KY" },
  { name: "Louisiana", code: "LA" },
  { name: "Maine", code: "ME" },
  { name: "Maryland", code: "MD" },
  { name: "Michigan", code: "MI" },
  { name: "Minnesota", code: "MN" },
  { name: "Mississippi", code: "MS" },
  { name: "Missouri", code: "MO" },
  { name: "Montana", code: "MT" },
  { name: "Nebraska", code: "NE" },
  { name: "Nevada", code: "NV" },
  { name: "New Hampshire", code: "NH" },
  { name: "New Jersey", code: "NJ" },
  { name: "New Mexico", code: "NM" },
  { name: "New York", code: "NY" },
  { name: "North Carolina", code: "NC" },
  { name: "North Dakota", code: "ND" },
  { name: "Ohio", code: "OH" },
  { name: "Oklahoma", code: "OK" },
  { name: "Oregon", code: "OR" },
  { name: "Pennsylvania", code: "PA" },
  { name: "Rhode Island", code: "RI" },
  { name: "South Carolina", code: "SC" },
  { name: "South Dakota", code: "SD" },
  { name: "Tennessee", code: "TN" },
  { name: "Texas", code: "TX" },
  { name: "Utah", code: "UT" },
  { name: "Vermont", code: "VT" },
  { name: "Virginia", code: "VA" },
  { name: "Washington", code: "WA" },
  { name: "West Virginia", code: "WV" },
  { name: "Wisconsin", code: "WI" },
  { name: "Wyoming", code: "WY" },];

export function foldPlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_FOLD = new Map(MA_TOWNS.map((t) => [foldPlace(t.name), t.name]));
const TOWNS_LONGEST_FIRST = MA_TOWNS.map((t) => ({ name: t.name, fold: foldPlace(t.name) })).sort(
  (a, b) => b.fold.length - a.fold.length || a.name.localeCompare(b.name),
);
const COUNTY_FOLDS = [...new Set(MA_TOWNS.map((t) => t.county))].map((c) => ({ county: c, fold: foldPlace(c) }));
const STATE_NAME_RE = OTHER_STATES.map((s) => new RegExp("(?<![a-z0-9])" + foldPlace(s.name) + "(?![a-z0-9])"));
const STATE_CODES = new Set(OTHER_STATES.map((s) => s.code));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (fold: string, flags = "g") => new RegExp("(?<![a-z0-9])" + esc(fold) + "(?![a-z0-9])", flags);

export function townOf(city: string | null | undefined): string | null {
  if (!city) return null;
  const f = foldPlace(city).replace(/ (ma|massachusetts)$/, "");
  return BY_FOLD.get(f) ?? null;
}

export function townsInRegion(text: string): { towns: string[]; outside: boolean; statewide: boolean } {
  let s = foldPlace(text);
  const hits: { pos: number; names: string[] }[] = [];
  const take = (re: RegExp, names: string[]) => {
    s = s.replace(re, (m: string, ...rest: unknown[]) => {
      const pos = rest.find((x) => typeof x === "number") as number;
      hits.push({ pos, names });
      return " ".repeat(m.length);
    });
  };
  const ofCounty = (c: string) => MA_TOWNS.filter((t) => t.county === c).map((t) => t.name);

  for (const { county, fold } of COUNTY_FOLDS) {
    take(word(fold + " county"), ofCounty(county));
    take(word("condado de " + fold), ofCounty(county));
  }
  take(word("cape cod"), ofCounty(REGION_ALIASES["cape cod"]));
  take(/(?<![a-z0-9])cape(?![a-z0-9])(?! ann(?![a-z0-9]))/g, ofCounty(REGION_ALIASES.cape));
  for (const { name, fold } of TOWNS_LONGEST_FIRST) take(word(fold), [name]);

  hits.sort((a, b) => a.pos - b.pos);
  const towns = [...new Set(hits.flatMap((h) => h.names))];
  if (towns.length) return { towns, outside: false, statewide: false };

  const outside = STATE_NAME_RE.some((re) => re.test(s)) || [...text.matchAll(/\b[A-Z]{2}\b/g)].some((m) => STATE_CODES.has(m[0]));
  const statewide = !outside && (/(?<![a-z0-9])massachusetts(?![a-z0-9])/.test(s) || /\bMA\b/.test(text) || s === "ma");
  return { towns: [], outside, statewide };
}
