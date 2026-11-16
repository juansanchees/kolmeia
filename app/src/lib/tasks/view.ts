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

/** "Adiar": the same time one day later, never earlier than now + 1 hour (a late task moves to the future). */
export function postponed(dueAt: string, now: Date): string {
  const next = Math.max(Date.parse(dueAt) + 86_400_000, now.getTime() + 3_600_000);
  return new Date(next).toISOString();
}
