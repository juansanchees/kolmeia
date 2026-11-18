// Codes to words for the Caçador screens, and the agent's reply built from codes (never free AI text).
import { fill, type Messages } from "@/lib/i18n";
import type { RoundSummary, StopReason } from "./rounds";

type HuntMessages = Messages["hunt"];

/** The message for a code; an unknown code falls back to the code itself so nothing renders blank. */
export const word = (map: Readonly<Record<string, string>>, code: string): string => map[code] ?? code;

export function agentReply(M: HuntMessages, i: { understood: string[]; unknown: string[]; summary?: RoundSummary; stop?: StopReason; head?: string }): string {
  const lines: string[] = [];
  if (i.head) lines.push(i.head);
  if (i.understood.length) lines.push(fill(M.reply.understood, { list: i.understood.map((c) => word(M.understood, c)).join("; ") }));
  for (const u of i.unknown) lines.push(fill(M.reply.unknown, { text: u }));
  if (i.summary) lines.push(fill(M.reply.result, { new: i.summary.new, updated: i.summary.updated, demoted: i.summary.demoted }));
  for (const c of i.summary?.blockers ?? []) lines.push(word(M.round.blockerCodes, c));
  for (const c of i.summary?.asks ?? []) lines.push(word(M.round.askCodes, c));
  if (i.stop) lines.push(word(M.round.stop, i.stop));
  return lines.join("\n").slice(0, 4000);
}
