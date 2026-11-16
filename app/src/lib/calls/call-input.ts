// Client-safe input rules of the call screen: the one-tap form's schema and the New York clock for "next step".
import { z } from "zod";
import type { LeadFieldRow } from "@/lib/leads/types";
import { phoneKey } from "@/lib/research/dedupe";
import type { CallOutcome } from "./types";

const TZ = "America/New_York";

/** The five buttons of "Registrar contato" (lead modal and call screen), in screen order. */
export const CONTACT_OUTCOMES = ["no_answer", "meeting_booked", "talked", "not_interested", "do_not_call"] as const satisfies readonly CallOutcome[];
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/** One tap is enough; the note is optional. "Ligar depois" (talked) needs the day to call back. */
export const contactSchema = z
  .object({
    leadId: z.uuid(),
    outcome: z.enum(CONTACT_OUTCOMES),
    note: z.string().trim().max(200),
    callBackOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  })
  .refine((d) => d.outcome !== "talked" || d.callBackOn !== null, { path: ["callBackOn"] });

const parts = (ms: number) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
};

/** "2026-11-16T09:00" read as New York wall time -> UTC ISO string; null when it is not a real date. */
export function nyLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess);
    guess += wall - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  }
  const p = parts(guess);
  if (p.y !== y || p.mo !== mo || p.d !== d || p.h !== h || p.mi !== mi) return null;
  return new Date(guess).toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A quick chip as a datetime-local value: 9:00 New York time, `days` after today. */
export function chipLocal(days: number, now: Date = new Date()): string {
  const p = parts(now.getTime());
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + days));
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T09:00`;
}

/** Same rule as SQL lead_phone: the best candidate's phone when it is a real number, else the newest non-refuted phone value. */
export function leadPhone(bestPhone: string | null | undefined, fields: Pick<LeadFieldRow, "field" | "value" | "status" | "seen_at">[]): string | null {
  if (bestPhone && phoneKey(bestPhone)) return bestPhone;
  const f = fields
    .filter((x) => x.field === "phone" && x.status !== "refuted" && phoneKey(x.value))
    .sort((a, b) => Date.parse(b.seen_at) - Date.parse(a.seen_at))[0];
  return f?.value ?? null;
}

/** "Ligar depois": the callback task is due at 9:00 New York time on that day; null when the day is not real. */
export function callBackAt(day: string): string | null {
  return nyLocalToIso(`${day}T09:00`);
}
