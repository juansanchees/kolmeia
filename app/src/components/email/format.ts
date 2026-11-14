// Dates for the E-mail screens: US Eastern time (where the prospects and the customer are), Brazilian format.

import { nextSendLabel } from "@/lib/email/schedule";

const TZ = "America/New_York";

export function when(iso: string | null | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** True when the moment has passed (evaluated once, on the server render). */
export function isPast(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

const RESUME_OUTCOMES = new Set(["daily_limit", "outside_window", "campaign_limit"]);

/** The {time} of a claim outcome: for the three "come back later" outcomes the next real sending moment (weekday when not today, campaign zone); else the plain clock time. */
export function outcomeTime(outcome: string, iso: string | null | undefined, campaignTz: string = TZ): string {
  return RESUME_OUTCOMES.has(outcome) ? nextSendLabel(iso, campaignTz) : timeOf(iso);
}
