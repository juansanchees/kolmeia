// Client-safe: which of Massachusetts' towns were searched in the last COVERAGE_DAYS days (K-8, C-e).
import { MA_COUNTIES, MA_TOWNS, type MaCounty } from "./ma-towns";
import { townOf, townsInRegion } from "./region";

export const COVERAGE_DAYS = 90;
const DAY_MS = 86_400_000;

export type CoverageSearch = {
  kind: "hunter" | "research" | "import" | "manual";
  label: string;
  regionText: string | null;
  /** Canonical towns when the source already knows them (imports, marks); otherwise they come from `regionText`. */
  towns: string[] | null;
  at: string;
  newCount: number | null;
  rows: number | null;
};

export type TownRow = { name: string; county: MaCounty; leads: number; searches: number; last: string | null; covered: boolean };

/** Towns, outside-MA flag and statewide flag of one search. */
export function placesOf(s: Pick<CoverageSearch, "regionText" | "towns">): { towns: string[]; outside: boolean; statewide: boolean } {
  if (s.towns) return { towns: [...new Set(s.towns.map(townOf).filter((x): x is string => x !== null))], outside: false, statewide: false };
  return s.regionText ? townsInRegion(s.regionText) : { towns: [], outside: false, statewide: false };
}

export function coverageTable(input: { searches: CoverageSearch[]; leadTowns: Map<string, number>; now: Date }): {
  towns: TownRow[];
  summary: { covered: number; uncovered: number };
  outside: number;
  statewide: number;
} {
  const { searches, leadTowns, now } = input;
  const stats = new Map<string, { searches: number; last: number; lastIso: string }>();
  let outside = 0;
  let statewide = 0;
  for (const s of searches) {
    const place = placesOf(s);
    if (place.outside) outside++;
    if (place.statewide) statewide++;
    const at = Date.parse(s.at);
    if (Number.isNaN(at)) continue;
    for (const name of place.towns) {
      const cur = stats.get(name);
      if (!cur) stats.set(name, { searches: 1, last: at, lastIso: s.at });
      else {
        cur.searches++;
        if (at > cur.last) {
          cur.last = at;
          cur.lastIso = s.at;
        }
      }
    }
  }
  const cutoff = now.getTime() - COVERAGE_DAYS * DAY_MS;
  const order = new Map(MA_COUNTIES.map((c, i) => [c as string, i]));
  const towns: TownRow[] = MA_TOWNS.map((t) => {
    const st = stats.get(t.name);
    return { name: t.name, county: t.county, leads: leadTowns.get(t.name) ?? 0, searches: st?.searches ?? 0, last: st?.lastIso ?? null, covered: !!st && st.last >= cutoff };
  }).sort((a, b) => (order.get(a.county)! - order.get(b.county)!) || a.name.localeCompare(b.name));
  const covered = towns.filter((t) => t.covered).length;
  return { towns, summary: { covered, uncovered: towns.length - covered }, outside, statewide };
}

export function huntHref(town: string): string {
  return `/agentes/novo?regiao=${encodeURIComponent(`${town}, MA`)}`;
}
