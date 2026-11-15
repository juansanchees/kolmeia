import type { TrainingRow } from "./types";

export const PROFILE_SAMPLE_MAX = 200;

const cityKey = (r: TrainingRow) => (r.city ?? "").trim().toLowerCase();

/**
 * At most `max` rows, spread over the cities: round-robin over cities (most rows first, then name), one row per city
 * per turn, each city's rows in row order. Deterministic. The result is in row order.
 */
export function sampleRows(rows: TrainingRow[], max = PROFILE_SAMPLE_MAX): TrainingRow[] {
  const byCity = new Map<string, TrainingRow[]>();
  for (const r of [...rows].sort((a, b) => a.row - b.row)) {
    const k = cityKey(r);
    byCity.set(k, [...(byCity.get(k) ?? []), r]);
  }
  const queues = [...byCity.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([, q]) => q);
  const out: TrainingRow[] = [];
  for (let turn = 0; out.length < max; turn++) {
    let any = false;
    for (const q of queues) {
      if (turn < q.length && out.length < max) {
        out.push(q[turn]);
        any = true;
      }
    }
    if (!any) break;
  }
  return out.sort((a, b) => a.row - b.row);
}
