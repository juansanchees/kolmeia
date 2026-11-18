/** Freshness windows in days (proposal; one constant for the whole base). */
export const KB_FRESH_DAYS = { phone: 90, website: 90, signal: 30 } as const;

/** True while `seenAt` is within the window (the boundary itself is still fresh). */
export function isFresh(kind: keyof typeof KB_FRESH_DAYS, seenAt: string, now: Date): boolean {
  const t = Date.parse(seenAt);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= KB_FRESH_DAYS[kind] * 86_400_000;
}
