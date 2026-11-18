// Coverage: one row per (town, source) saying what was tried, when and what came back.
export type CoverageOutcome = "ok" | "partial" | "blocked" | "robots" | "down" | "login" | "empty" | "skipped";
export type CoverageRow = { town: string; source: string; ran_at: string; outcome: CoverageOutcome; queried: number; rows_in: number; reason?: string };

// When several bad outcomes meet, the most "the source said no" one wins.
const BAD_ORDER: CoverageOutcome[] = ["robots", "blocked", "login", "down", "empty", "skipped"];

/** Reduces many runs to one row per (town, source): latest time, summed counts, `partial` when some worked and some did not. */
export function reduceCoverage(rows: CoverageRow[]): CoverageRow[] {
  const groups = new Map<string, CoverageRow[]>();
  for (const r of rows) {
    const k = `${r.town.toLowerCase()}\u0000${r.source}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const outcomes = new Set(g.map((r) => r.outcome));
    const outcome: CoverageOutcome =
      outcomes.size === 1 ? g[0].outcome : outcomes.has("ok") || outcomes.has("partial") ? "partial" : (BAD_ORDER.find((o) => outcomes.has(o)) ?? "partial");
    const reasons = [...new Set(g.map((r) => r.reason).filter((x): x is string => !!x))].join("; ").slice(0, 300);
    const row: CoverageRow = {
      town: g[0].town,
      source: g[0].source,
      ran_at: g.map((r) => r.ran_at).sort().at(-1)!,
      outcome,
      queried: g.reduce((a, r) => a + r.queried, 0),
      rows_in: g.reduce((a, r) => a + r.rows_in, 0),
    };
    if (reasons) row.reason = reasons;
    return row;
  });
}
