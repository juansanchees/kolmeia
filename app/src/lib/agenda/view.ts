// Client-safe rules of the Agenda (Início > Agenda): the URL (month, day, view), the month grid by New York calendar
// day, the three kinds and their filters, and the "atrasado" flag. Days are "yyyy-mm-dd" strings, never Date math in
// the browser's own zone.
import { nyDay } from "@/lib/calls/ny-day";
import type { TaskKind, TaskRow } from "@/lib/tasks/view";

export const AGENDA_VIEWS = ["mes", "semana", "lista"] as const;
export type AgendaView = (typeof AGENDA_VIEWS)[number];
export const AGENDA_KINDS = ["returns", "meetings", "emails"] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];
/** What "Marcar retorno ou reunião" can create: retorno = a call back. */
export const NEW_TASK_KINDS = ["call", "meeting", "email"] as const;
export type NewTaskKind = (typeof NEW_TASK_KINDS)[number];

/** Retornos = call / follow-up (and "other"); Reuniões = meeting; E-mails = email. */
export const kindGroup = (k: TaskKind): AgendaKind => (k === "meeting" ? "meetings" : k === "email" ? "emails" : "returns");

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
export const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
export const addDays = (day: string, n: number) => ymd(utc(day) + n * DAY);
/** 0 = Sunday. */
export const weekdayOf = (day: string) => new Date(utc(day)).getUTCDay();

export type AgendaState = { year: number; month: number; day: string; view: AgendaView; today: string };

/** ?m=2026-11&d=17&v=mes. Anything missing or invalid falls back: this month, today (or the 1st of another month), month view. */
export function parseAgenda(sp: { m?: unknown; d?: unknown; v?: unknown }, now: Date): AgendaState {
  const today = nyDay(now);
  const m = typeof sp.m === "string" ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(sp.m) : null;
  const ok = m && +m[1] >= 2000 && +m[1] <= 2100;
  const year = ok ? +m[1] : +today.slice(0, 4);
  const month = ok ? +m[2] : +today.slice(5, 7);
  const d = typeof sp.d === "string" && /^\d{1,2}$/.test(sp.d) ? +sp.d : NaN;
  const sameMonth = `${year}-${pad(month)}` === today.slice(0, 7);
  const dayN = d >= 1 && d <= daysInMonth(year, month) ? d : sameMonth ? +today.slice(8, 10) : 1;
  const view = AGENDA_VIEWS.find((x) => x === sp.v) ?? "mes";
  return { year, month, day: `${year}-${pad(month)}-${pad(dayN)}`, view, today };
}

/** The month as full weeks, Sunday first: days of the month plus the neighbours that fill its first and last week. */
export function monthGrid(year: number, month: number): string[][] {
  const first = ymd(Date.UTC(year, month - 1, 1));
  const last = ymd(Date.UTC(year, month - 1, daysInMonth(year, month)));
  let day = addDays(first, -weekdayOf(first));
  const end = addDays(last, 6 - weekdayOf(last));
  const weeks: string[][] = [];
  while (day <= end) {
    const w: string[] = [];
    for (let i = 0; i < 7; i++, day = addDays(day, 1)) w.push(day);
    weeks.push(w);
  }
  return weeks;
}

/** "2026-12" for one month after November 2026 (by = -1 / +1). */
export function shiftMonth(year: number, month: number, by: number): string {
  const d = new Date(Date.UTC(year, month - 1 + by, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** The link of a day/view: ?m=yyyy-mm&d=dd&v=view. */
export const agendaHref = (day: string, view: AgendaView) => `/inicio/agenda?m=${day.slice(0, 7)}&d=${+day.slice(8, 10)}&v=${view}`;

export type AgendaItem = Pick<TaskRow, "id" | "lead_id" | "kind" | "title" | "due_at" | "done_at" | "assignee_id">;

/** Open and its New York day already passed. */
export const isLate = (x: Pick<AgendaItem, "due_at" | "done_at">, today: string) => !x.done_at && nyDay(new Date(x.due_at)) < today;

/** "De quem": everyone, only the user's own, or one member. */
export type Who = "all" | "mine" | string;

export function filterAgenda<T extends AgendaItem>(items: T[], kinds: ReadonlySet<AgendaKind>, who: Who, me: string): T[] {
  const person = who === "mine" ? me : who;
  return items.filter((x) => kinds.has(kindGroup(x.kind)) && (who === "all" || x.assignee_id === person));
}

/** Items by New York day, each day in due order. */
export function byDay<T extends AgendaItem>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of [...items].sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at) || a.id.localeCompare(b.id))) {
    const d = nyDay(new Date(x.due_at));
    m.set(d, [...(m.get(d) ?? []), x]);
  }
  return m;
}
