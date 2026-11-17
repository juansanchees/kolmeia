// Draft of the closer brief for a lead (F5, no AI). Client-safe: the form edits it before the hand-off.
import type { CloserBrief } from "@/lib/email/types";
import { sanitizeUrl } from "@/lib/safe-url";
import { ptMessages, type Messages } from "@/lib/i18n";

/** Same limits as public.is_closer_brief (0020 / 0007). */
export const BRIEF_LIMITS = { who: 600, what_they_said: 800, next_step: 400, evidence_urls: 4 } as const;

export type BriefDraft = Omit<CloserBrief, "model"> & { model: "manual" };

export function draftBrief(input: {
  company: string;
  askForName: string | null;
  askForTitle: string | null;
  emailBrief: CloserBrief | null;
  talkedNotes: string | null;
  proofUrls: string[];
}, t: Messages): BriefDraft {
  const { emailBrief } = input;
  const person = [input.askForName, input.askForTitle].map((s) => s?.trim()).filter(Boolean).join(", ");
  const who = emailBrief?.who.trim() || (person ? `${person} · ${input.company}` : input.company);
  const said = emailBrief?.what_they_said.trim() || input.talkedNotes?.trim() || ptMessages.handoff.noTalkYet; // stored data stays Portuguese
  const urls = [...(emailBrief?.evidence_urls ?? []), ...input.proofUrls].map((u) => sanitizeUrl(u)).filter((u): u is string => Boolean(u));
  return {
    who: who.slice(0, BRIEF_LIMITS.who),
    what_they_said: said.slice(0, BRIEF_LIMITS.what_they_said),
    next_step: (emailBrief?.next_step ?? "").slice(0, BRIEF_LIMITS.next_step),
    evidence_urls: [...new Set(urls)].slice(0, BRIEF_LIMITS.evidence_urls),
    model: "manual",
  };
}
