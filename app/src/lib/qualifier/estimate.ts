// Client-safe: the worst-case cost of qualifying leads on request (J-3 B). No server imports.

/** spentUsd = the lead's settled spend plus what its pending AI calls still hold in reserve. */
export type EstimateRow = { level: number; spentUsd: number };
export type EstimateCosts = { leadCapUsd: number; placesUsd: number | null; lightUsd: number; deepUsd: number };

/**
 * Per lead the worst case (Places below level 2 and only with a key, the light step, the full deep step), capped by
 * what the lead's cap still has left. Every queued lead counts, dead ones too: a request revives them (request_qualification).
 * A level-4 lead gets no deep step. The sum is rounded up to the cent.
 */
export function estimateQualifyUsd(rows: EstimateRow[], c: EstimateCosts): number {
  let sum = 0;
  for (const r of rows) {
    const left = Math.max(0, c.leadCapUsd - r.spentUsd);
    const worst = (c.placesUsd !== null && r.level < 2 ? c.placesUsd : 0) + c.lightUsd + (r.level >= 4 ? 0 : c.deepUsd);
    sum += Math.min(left, worst);
  }
  return Math.ceil(Math.round(sum * 1_000_000) / 10_000) / 100;
}
