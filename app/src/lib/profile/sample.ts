import type { TrainingRow } from "./types";

export const PROFILE_SAMPLE_MAX = 200;

/** The room the rows get inside the wrapper (`untrusted` keeps 20 000 characters), minus a margin for the header. */
export const PROFILE_ROWS_BUDGET_CHARS = 19_000;
export const ROW_HEADER = "row|name|city|state|website|contact_title|note";

const clip = (v: string | null, n: number) => (v ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** One row as one line: `row|name|city|state|website|contact_title|note`, fields clipped, no `|` or newline inside. */
export function rowLine(r: TrainingRow): string {
  return [r.row, clip(r.name, 80), clip(r.city, 40), clip(r.state, 10), clip(r.website, 80), clip(r.contact_title, 60), clip(r.note, 120)].join("|");
}

const cityKey = (r: TrainingRow) => (r.city ?? "").trim().toLowerCase();

/**
 * At most `max` rows (and, when `maxChars` is given, rows whose lines fit it), spread over the cities: round-robin over cities (most rows first, then name), one row per city
 * per turn, each city's rows in row order. Deterministic. The result is in row order.
 */
export function sampleRows(rows: TrainingRow[], max = PROFILE_SAMPLE_MAX, maxChars = Infinity): TrainingRow[] {
  const byCity = new Map<string, TrainingRow[]>();
  for (const r of [...rows].sort((a, b) => a.row - b.row)) {
    const k = cityKey(r);
    byCity.set(k, [...(byCity.get(k) ?? []), r]);
  }
  const queues = [...byCity.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([, q]) => q);
  const out: TrainingRow[] = [];
  let used = ROW_HEADER.length;
  // Stop at the first row that does not fit: later rows of the round-robin are dropped, never a row cut in half.
  for (let turn = 0; out.length < max; turn++) {
    let any = false;
    for (const q of queues) {
      if (turn < q.length && out.length < max) {
        const cost = rowLine(q[turn]).length + 1;
        if (used + cost > maxChars) return out.sort((a, b) => a.row - b.row);
        used += cost;
        out.push(q[turn]);
        any = true;
      }
    }
    if (!any) break;
  }
  return out.sort((a, b) => a.row - b.row);
}
