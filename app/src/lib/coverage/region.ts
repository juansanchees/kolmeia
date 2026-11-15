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
  { name: "Wyoming", code: "WY" },
];

export function foldPlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_FOLD = new Map(MA_TOWNS.map((t) => [foldPlace(t.name), t.name]));
const words = (s: string) => foldPlace(s).split(" ");
const TOWNS_LONGEST_FIRST = MA_TOWNS.map((t) => ({ name: t.name, w: words(t.name) })).sort(
  (a, b) => b.w.join(" ").length - a.w.join(" ").length || a.name.localeCompare(b.name),
);
const COUNTIES = [...new Set(MA_TOWNS.map((t) => t.county))];
const ofCounty = (c: string) => MA_TOWNS.filter((t) => t.county === c).map((t) => t.name);
const STATE_NAMES = [...OTHER_STATES.map((s) => words(s.name)), ["district", "of", "columbia"]];
const STATE_CODES = new Set([...OTHER_STATES.map((s) => s.code.toLowerCase()), "dc"]);

type Tok = { w: string; raw: string; comma: boolean };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /([^\p{L}\p{N}]*)([\p{L}\p{N}]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = foldPlace(m[2]).split(" ").filter(Boolean);
    for (const w of parts) out.push({ w, raw: m[2], comma: m[1].includes(",") });
  }
  return out;
}

const matchAt = (t: Tok[], i: number, w: string[]) => w.every((x, k) => t[i + k]?.w === x);

// A non-MA state name or code: names always; codes only uppercase in the text or right after a comma.
function stateAt(t: Tok[], i: number): number {
  for (const n of STATE_NAMES) if (matchAt(t, i, n)) return n.length;
  const k = t[i];
  if (k && STATE_CODES.has(k.w) && k.w.length === 2 && (k.comma || k.raw === k.raw.toUpperCase())) return 1;
  if (k && k.w === "dc" && k.raw === "DC") return 1;
  return 0;
}

const CAPE_OK_NEXT = new Set(["and", "islands", "ma", "massachusetts", "mass"]);

function stripTail(f: string): string {
  let prev = "";
  while (prev !== f) {
    prev = f;
    f = f
      .replace(/ \d{5}( \d{4})?$/, "")
      .replace(/ usa$/, "")
      .replace(/ (ma|massachusetts|mass)$/, "");
  }
  return f;
}

export function townOf(city: string | null | undefined): string | null {
  if (!city) return null;
  return BY_FOLD.get(stripTail(foldPlace(city))) ?? null;
}

export function townsInRegion(text: string): { towns: string[]; outside: boolean; statewide: boolean } {
  const t = tokenize(text);
  const used = new Array<boolean>(t.length).fill(false);
  const hits: { pos: number; names: string[] }[] = [];

  const take = (w: string[], names: string[], capeCheck = false) => {
    for (let i = 0; i + w.length <= t.length; i++) {
      if (!matchAt(t, i, w) || used.slice(i, i + w.length).some(Boolean)) continue;
      const j = i + w.length;
      const next = t[j];
      let ok = !stateAt(t, j);
      if (capeCheck && next && !next.comma && !CAPE_OK_NEXT.has(next.w) && !stateAt(t, j)) ok = false;
      for (let k = i; k < j; k++) used[k] = true;
      if (ok) hits.push({ pos: i, names });
    }
  };

  for (const c of COUNTIES) {
    take([...words(c), "county"], ofCounty(c));
    take(["condado", "de", ...words(c)], ofCounty(c));
  }
  take(["cape", "cod"], ofCounty("Barnstable"));
  take(["cape"], ofCounty(REGION_ALIASES.cape), true);
  for (const { name, w } of TOWNS_LONGEST_FIRST) take(w, [name]);

  hits.sort((a, b) => a.pos - b.pos);
  const towns = [...new Set(hits.flatMap((h) => h.names))];
  if (towns.length) return { towns, outside: false, statewide: false };

  const outside = t.some((_, i) => stateAt(t, i) > 0);
  const statewide =
    !outside &&
    (t.some((k) => k.w === "massachusetts" || k.w === "mass" || (k.w === "ma" && k.raw === "MA")) ||
      (t.length === 1 && t[0].w === "ma"));
  return { towns: [], outside, statewide };
}
