// Client-safe input rules of the call screen: the one-tap form's schema and the New York clock for "next step".
import { z } from "zod";
import type { LeadFieldRow } from "@/lib/leads/types";
import { phoneKey } from "@/lib/research/dedupe";
import { CALL_OUTCOMES } from "./types";

const TZ = "America/New_York";

/** Only the outcome is required: one tap. Everything else may be empty. */
export const logCallSchema = z.object({
  leadId: z.uuid(),
  agentId: z.uuid().nullable(),
  outcome: z.enum(CALL_OUTCOMES),
  spokeTo: z.string().trim().max(120),
  notes: z.string().trim().max(500),
  nextStep: z.string().trim().max(200),
  nextAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable(),
});

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
