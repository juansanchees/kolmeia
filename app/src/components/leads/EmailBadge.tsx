import type { EmailQuality } from "@/lib/leads/email-quality";
import { t } from "@/messages/pt";

const Q = t.leads.emailQuality;

// Fixed colours of the four verdicts (Fase 2 brief); text on its own wash keeps AA contrast.
const CLS: Record<EmailQuality, string> = {
  verified: "bg-[#e2f3eb] text-[#0b6b47]",
  domain_ok: "bg-[#e2f3eb] text-[#0b6b47]",
  catch_all: "bg-[#fff1e0] text-[#7a3e00]",
  unknown: "bg-[#eceef2] text-[#3a4358]",
  invalid: "bg-[#fbe9e7] text-[#b3261e]",
};

/** The quality of a lead's e-mail; nothing when it was never checked. */
export function EmailBadge({ quality }: { quality: EmailQuality | null | undefined }) {
  if (!quality) return null;
  return (
    <span title={Q.hints[quality]} className={`inline-block whitespace-nowrap px-1.5 py-0.5 font-mono text-xs ${CLS[quality]}`}>
      {Q.labels[quality]}
    </span>
  );
}
