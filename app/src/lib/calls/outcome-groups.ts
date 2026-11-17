// "Resultados": every lead sits in ONE group, the one of its most recent call_log. Pure, client-safe.
import type { CallOutcome } from "./types";

/** Tab order. "Ligar depois" is how the modal stores `talked` (it always carries a call-back day). */
export const OUTCOME_GROUPS = ["no_answer", "meeting_booked", "call_back", "not_interested", "do_not_call", "voicemail", "wrong_number"] as const;
export type OutcomeGroup = (typeof OUTCOME_GROUPS)[number];

export type OutcomeLog = { id: string; lead_id: string; outcome: CallOutcome; called_at: string };

/** gatekeeper (Recepção) counts as Não atendeu; talked is Ligar depois. */
export const groupOf = (o: CallOutcome): OutcomeGroup => (o === "gatekeeper" ? "no_answer" : o === "talked" ? "call_back" : o);

/** Latest call per lead wins (called_at, then id); returns each group's logs, newest first. */
export function latestOutcomeGroups<T extends OutcomeLog>(logs: T[]): Record<OutcomeGroup, T[]> {
  const newer = (a: T, b: T) => (a.called_at !== b.called_at ? Date.parse(a.called_at) - Date.parse(b.called_at) : a.id.localeCompare(b.id));
  const last = new Map<string, T>();
  for (const l of logs) {
    const cur = last.get(l.lead_id);
    if (!cur || newer(l, cur) > 0) last.set(l.lead_id, l);
  }
  const out = Object.fromEntries(OUTCOME_GROUPS.map((g) => [g, [] as T[]])) as Record<OutcomeGroup, T[]>;
  for (const l of [...last.values()].sort((a, b) => newer(b, a))) out[groupOf(l.outcome)].push(l);
  return out;
}
