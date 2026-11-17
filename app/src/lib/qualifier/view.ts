// Client-safe: how the Qualificador and the level read on screen. No server imports.
import { usd } from "@/components/research/format";
import type { LeadFieldRow } from "@/lib/leads/types";
import { fill, type Messages } from "@/lib/i18n";

/** What `qualifier_status(ws)` returns (migration 0014). Numbers arrive as JSON numbers. */
export type QualifierStatus = {
  status: "on" | "paused";
  paused_reason: "user" | "daily_cap" | "workspace_cap" | "user_cap" | "global_cap" | "no_access" | null;
  paused_until: string | null;
  daily_cap_usd: number;
  lead_cap_usd: number;
  auto_deep: boolean;
  queued: number;
  done_today: number;
  spent_today: number;
  levels: Record<string, number>;
  steps_today: { free: number; places: number; light: number; deep: number };
};

/** "●●○○○" for 2: five dots, levels run 0-4 (so 4 is "●●●●○"). Out-of-range values are clamped to 0..4. */
export function levelDots(n: number): string {
  const k = Math.max(0, Math.min(4, Math.trunc(Number.isFinite(n) ? n : 0)));
  return "●".repeat(k) + "○".repeat(5 - k);
}

/** Why the lead is at this level: the fixed name of the level. `fields` is kept for callers that will cite a value later. */
export function levelReason(_fields: LeadFieldRow[], level: number, t: Messages): string {
  const Q = t.qualifier;
  const k = Math.max(0, Math.min(4, Math.trunc(level))) as 0 | 1 | 2 | 3 | 4;
  return Q.levelNames[k];
}

/** Name of what a level note cites: a lead field, a research check kind, or "candidate". */
export function noteFieldLabel(field: string, t: Messages): string {
  const Q = t.qualifier;
  const own = Q.noteFields as Record<string, string>;
  if (field in own) return own[field];
  const lead = t.leads.fieldLabels as Record<string, string>;
  return lead[field] ?? Q.noteFields.other;
}

export function nextStepLabel(nextStep: string, doneReason: string | null, t: Messages): string {
  const Q = t.qualifier;
  if (nextStep in Q.nextSteps) return Q.nextSteps[nextStep as keyof typeof Q.nextSteps];
  if (doneReason === "lead_cap") return Q.done.lead_cap;
  if (doneReason === "dead") return Q.done.dead;
  return Q.done.complete;
}

export function cardLines(
  s: QualifierStatus,
  placesOn: boolean,
  t: Messages,
): { queued: string; today: string; spent: string; levels: [number, number][]; steps: string; warning: string | null } {
  const Q = t.qualifier;
  return {
    queued: fill(Q.queued, { queued: s.queued }),
    today: fill(Q.doneToday, { done: s.done_today }),
    spent: fill(Q.spent, { spent: usd(s.spent_today, t.intl), cap: usd(s.daily_cap_usd, t.intl) }),
    levels: [0, 1, 2, 3, 4].map((n): [number, number] => [n, s.levels[String(n)] ?? 0]),
    steps: fill(Q.steps, s.steps_today),
    warning: placesOn ? null : Q.placesOff,
  };
}
