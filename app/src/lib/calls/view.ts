// Client-safe call rules: the status a call leads to, the tel: link, and the call agent's numbers.
import type { LeadStatus } from "@/lib/leads/types";
import { phoneKey } from "@/lib/research/dedupe";
import { ANSWERED, type CallListItemRow, type CallLogRow, type CallOutcome } from "./types";

/** Same table as SQL lead_status_after_call (0020), pinned by tests/fixtures/call-status-vectors.ts. */
export function statusAfterCall(status: LeadStatus, outcome: CallOutcome): LeadStatus {
  if (status === "won" || status === "discarded") return status;
  if (outcome === "meeting_booked") return "meeting";
  if (outcome === "not_interested" || outcome === "do_not_call") return "lost";
  return status === "new" ? "call_list" : status;
}

/** A US number to tap: tel:+1 and its last 10 digits; null when it has fewer than 10. Never an sms: link. */
export function telHref(phone: string): string | null {
  const key = phoneKey(phone);
  return key ? `tel:+1${key}` : null;
}

/** The call agent card (spec §6.6), over the leads on the list: in the list, called, answered, meeting booked. */
export function callAgentMetrics(
  items: Pick<CallListItemRow, "lead_id">[],
  calls: Pick<CallLogRow, "lead_id" | "outcome">[],
): { inList: number; called: number; answered: number; meetings: number } {
  const listed = new Set(items.map((i) => i.lead_id));
  const called = new Set<string>();
  const answered = new Set<string>();
  const meetings = new Set<string>();
  for (const c of calls) {
    if (!listed.has(c.lead_id)) continue;
    called.add(c.lead_id);
    if (ANSWERED.includes(c.outcome)) answered.add(c.lead_id);
    if (c.outcome === "meeting_booked") meetings.add(c.lead_id);
  }
  return { inList: listed.size, called: called.size, answered: answered.size, meetings: meetings.size };
}
