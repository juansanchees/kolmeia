// Client-safe rules of the Tarefas page (migration 0027).
import { nyDay } from "@/lib/calls/ny-day";

export const TASK_KINDS = ["call", "email", "follow_up", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_TABS = ["today", "late", "next"] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export type TaskRow = { id: string; lead_id: string; kind: TaskKind; title: string; due_at: string; done_at: string | null; assignee_id: string | null };

/** Today / late / next by the New York calendar day (the same day the call list uses). */
export function taskTab(dueAt: string, now: Date): TaskTab {
  const due = nyDay(new Date(dueAt));
  const today = nyDay(now);
  return due === today ? "today" : due < today ? "late" : "next";
}

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** New York's offset from UTC at instant `ms`, in ms (-4 h in summer, -5 h in winter). */
function nyOffset(ms: number): number {
  const p = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * "Adiar": the next calendar day in New York at the same local time (a DST change does not shift the hour), never earlier
 * than now + 1 hour (a late task moves to the future).
 */
export function postponed(dueAt: string, now: Date): string {
  const due = Date.parse(dueAt);
  const guess = due + 86_400_000;
  const next = guess + nyOffset(due) - nyOffset(guess);
  return new Date(Math.max(next, now.getTime() + 3_600_000)).toISOString();
}
