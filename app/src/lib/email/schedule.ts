import type { CampaignRow } from "./types";
// Business days (Mon-Fri, UTC calendar, no holidays). Mirrors public.add_business_days() in migration 0003.

export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let n = 0;
  while (n < Math.max(0, Math.floor(days))) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return d;
}

export type StepDelays = { step2: number; step3: number };

/** Validated per-campaign delays: step 2 between 1 and 30 business days, step 3 later than step 2 and at most 60. */
export function validDelays(d: StepDelays): boolean {
  return Number.isInteger(d.step2) && Number.isInteger(d.step3) && d.step2 >= 1 && d.step2 <= 30 && d.step3 > d.step2 && d.step3 <= 60;
}

/** When each step of the sequence is due, given when step 1 went out. */
export function sequenceDates(step1SentAt: Date, d: StepDelays): { step1: Date; step2: Date; step3: Date } {
  return { step1: step1SentAt, step2: addBusinessDays(step1SentAt, d.step2), step3: addBusinessDays(step1SentAt, d.step3) };
}

const WEEKDAYS_PT = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];

/** The pieces of the read-only schedule line on the campaign page (ISO days: 1 = Monday .. 7 = Sunday). */
export function scheduleParts(c: Pick<CampaignRow, "send_days" | "window_start" | "window_end" | "timezone" | "daily_limit">): {
  days: string;
  start: string;
  end: string;
  tz: string;
  limit: number;
} {
  const sorted = [...new Set(c.send_days)].sort((a, b) => a - b);
  const contiguous = sorted.length >= 3 && sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  const name = (d: number) => WEEKDAYS_PT[d - 1] ?? String(d);
  const days = contiguous ? `${name(sorted[0]!)} a ${name(sorted[sorted.length - 1]!)}` : sorted.map(name).join(", ");
  return { days, start: c.window_start.slice(0, 5), end: c.window_end.slice(0, 5), tz: c.timezone, limit: c.daily_limit };
}

/**
 * When sending resumes, for the screens: "às 09:00" when the moment is still on today's date in the campaign's time
 * zone, "segunda às 09:00" (pt-BR weekday) when it is another day. "?" for a missing or invalid instant.
 */
export function nextSendLabel(iso: string | null | undefined, tz: string, now: Date = new Date()): string {
  if (!iso) return "?";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "?";
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const hhmm = at.toLocaleTimeString("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (day(at) === day(now)) return `às ${hhmm}`;
  const weekday = at.toLocaleDateString("pt-BR", { timeZone: tz, weekday: "long" }).replace(/-feira$/, "");
  return `${weekday} às ${hhmm}`;
}

/** Offset of `tz` from UTC at instant `t`, in ms: the wall clock of `t` in `tz` read as UTC, minus `t`. */
function zoneOffsetMs(tz: string, t: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(t / 1000) * 1000;
}

/** Local midnight (start of the calendar day of `at` in `tz`) as an instant. Mirrors public.local_day_start(); DST-safe (two passes). */
export function localDayStart(tz: string, at: Date): Date {
  const [y, m, d] = at.toLocaleDateString("en-CA", { timeZone: tz }).split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  return new Date(guess - zoneOffsetMs(tz, guess - zoneOffsetMs(tz, guess)));
}
