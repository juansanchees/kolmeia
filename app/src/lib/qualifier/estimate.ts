// Client-safe: the worst-case cost of qualifying leads on request (J-3 B). No server imports.

export type EstimateRow = { level: number; spentUsd: number; doneReason: string | null };
export type EstimateCosts = { leadCapUsd: number; placesUsd: number | null; lightUsd: number; deepUsd: number };

/**
 * Per lead the worst case (Places below level 2 and only with a key, the light step, the full deep step), capped by
 * what the lead's cap still has left. A dead lead costs 0. The sum is rounded up to the cent.
 */
export function estimateQualifyUsd(rows: EstimateRow[], c: EstimateCosts): number {
  let sum = 0;
  for (const r of rows) {
    if (r.doneReason === "dead") continue;
    const left = Math.max(0, c.leadCapUsd - r.spentUsd);
    const worst = (c.placesUsd !== null && r.level < 2 ? c.placesUsd : 0) + c.lightUsd + c.deepUsd;
    sum += Math.min(left, worst);
  }
  return Math.ceil(Math.round(sum * 1_000_000) / 10_000) / 100;
}
