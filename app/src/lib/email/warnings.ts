import type { EmailQuality } from "@/lib/leads/email-quality";
import { senderComplete } from "./compose";
import type { SenderProfile } from "./types";
import { fill, ptMessages, type Messages } from "@/lib/i18n";

// Warning strip for Campanhas. Pure: the layout loads the rows, this decides what to say (read-only, no side effects).

export type CampaignWarning = {
  kind: "mailbox_error" | "mailbox_paused" | "no_leads" | "daily_limit" | "high_bounce" | "rehearsal_only" | "sender_profile_incomplete" | "agent_campaign_no_mailbox" | "spam_risk";
  text: string;
  href: string;
};

export type WarningsInput = {
  mailboxes: { id: string; email: string; status: "unverified" | "ok" | "error"; health_status: "ok" | "paused_bounce"; daily_limit: number }[];
  /** sent / bounced = real sequence mails sent and prospects stopped by a bounce, per campaign. */
  campaigns: { id: string; name: string; status: string; send_mode: string; sent: number; bounced: number; agent_id?: string | null; mailbox_count?: number }[];
  /** Real mails sent today, by mailbox id. */
  sentToday: Record<string, number>;
  /** Active prospects, by campaign id. */
  prospectsByCampaign: Record<string, number>;
  /** C12 checklist complete (real sending allowed). */
  gateOpen: boolean;
  /** CAN-SPAM sender profile (legal name, postal address, sender name). */
  sender: SenderProfile | null;
  /** Drafts awaiting approval that fail a content check (contentChecks, recipient aside), by campaign id. */
  spamDrafts?: Record<string, number>;
};

const BOUNCE_MIN = 3; // same rule as the mailbox auto-pause (D7): >= 3 bounces and >= 5 %
const BOUNCE_RATE = 0.05;

export function campaignWarnings(i: WarningsInput, t: Messages): CampaignWarning[] {
  const W = t.email.warnings;
  const active = i.campaigns.filter((c) => c.status === "active");
  const box = (kind: CampaignWarning["kind"], text: string): CampaignWarning => ({ kind, text, href: "/campanhas" });
  return [
    ...i.mailboxes.filter((m) => m.status !== "ok").map((m) => box("mailbox_error", fill(W.mailbox_error, { email: m.email }))),
    ...i.mailboxes.filter((m) => m.health_status === "paused_bounce").map((m) => box("mailbox_paused", fill(W.mailbox_paused, { email: m.email }))),
    ...active.filter((c) => (i.prospectsByCampaign[c.id] ?? 0) === 0).map((c) => ({ kind: "no_leads" as const, text: fill(W.no_leads, { name: c.name }), href: `/campanhas/${c.id}` })),
    ...i.mailboxes.filter((m) => m.daily_limit > 0 && (i.sentToday[m.id] ?? 0) >= m.daily_limit).map((m) => box("daily_limit", fill(W.daily_limit, { email: m.email }))),
    ...i.campaigns
      .filter((c) => c.bounced >= BOUNCE_MIN && c.bounced / Math.max(c.sent, 1) >= BOUNCE_RATE)
      .map((c) => ({ kind: "high_bounce" as const, text: fill(W.high_bounce, { name: c.name }), href: `/campanhas/${c.id}` })),
    ...(!i.gateOpen && active.length > 0 ? [box("rehearsal_only", W.rehearsal_only)] : []),
    ...(senderComplete(i.sender) ? [] : [box("sender_profile_incomplete", W.sender_profile_incomplete)]),
    ...active
      .filter((c) => c.agent_id && (c.mailbox_count ?? 0) === 0)
      .map((c) => ({ kind: "agent_campaign_no_mailbox" as const, text: fill(W.agent_campaign_no_mailbox, { name: c.name }), href: `/campanhas/${c.id}` })),
    ...i.campaigns
      .filter((c) => (i.spamDrafts?.[c.id] ?? 0) > 0)
      .map((c) => ({ kind: "spam_risk" as const, text: fill(W.spam_risk, { name: c.name, n: i.spamDrafts![c.id] }), href: `/campanhas/${c.id}/revisar` })),
  ];
}

// ---------------------------------------------------------------- content checks before approval (Fase 3, item 11)
// Local rules only (no service, no AI). A warning never blocks: the person decides; the table checks still refuse
// links and fake "Re:" in sequence e-mails (R4, R12).

/** Common spam-filter trigger words and phrases (English: the e-mails go to US companies). */
export const SPAM_WORDS = [
  "free", "guarantee", "guaranteed", "act now", "limited time", "urgent", "risk-free", "risk free", "no obligation", "100%",
  "winner", "cash", "click here", "buy now", "order now", "call now", "apply now", "special promotion", "best price", "lowest price",
  "cheap", "discount", "earn money", "make money", "once in a lifetime", "satisfaction guaranteed", "dear friend", "congratulations",
  "exclusive deal", "save big", "incredible deal", "no cost", "double your", "amazing", "miracle", "this is not spam",
] as const;
/** Same ceiling as the draft prompt (50-110 words per e-mail, prompts/email.ts STYLE). */
export const MAX_WORDS = 110;
/** Upper-case words that are names, not shouting. */
const CAPS_OK = new Set(["HVAC", "BERDO", "LLC", "INC", "CORP", "USA", "ASAP", "CEO", "COO", "CFO", "VRF", "AC"]);

export type ContentCheckKind = "spam_words" | "links" | "length" | "caps" | "exclaims" | "recipient";
export type ContentCheck = { kind: ContentCheckKind; ok: boolean; text: string };
export type ContentInput = {
  subject: string;
  body: string;
  step: number | null;
  /** The recipient's checked quality (0028 email_checks); null = never checked. Leave undefined to skip this check. */
  recipient?: EmailQuality | null;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function contentChecks(i: ContentInput, t: Messages): ContentCheck[] {
  const C = t.email.checks;
  const all = `${i.subject}\n${i.body}`;
  // "feel free" is a polite phrase, not the spam word "free"
  const low = all.toLowerCase().replace(/feel\s+free/g, " ");
  const spam = SPAM_WORDS.filter((w) => new RegExp(`(?<![a-z0-9])${esc(w)}(?![a-z0-9])`).test(low));
  const links = i.step === 1 ? (all.match(/https?:\/\/|www\./gi) ?? []).length : 0;
  const words = i.body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const caps = [...new Set((all.match(/\b[A-Z][A-Z'-]{3,}\b/g) ?? []).filter((w) => !CAPS_OK.has(w)))];
  const subjectCaps = /[A-Z]{4}/.test(i.subject) && i.subject === i.subject.toUpperCase();
  const bangs = (all.match(/!/g) ?? []).length;
  const out: ContentCheck[] = [
    { kind: "spam_words", ok: spam.length === 0, text: spam.length ? fill(C.spamFound, { words: spam.join(", ") }) : C.spamOk },
    { kind: "links", ok: links === 0, text: links ? fill(C.linksFound, { n: links }) : C.linksOk },
    { kind: "length", ok: words <= MAX_WORDS, text: fill(words <= MAX_WORDS ? C.lengthOk : C.lengthLong, { n: words }) },
    { kind: "caps", ok: caps.length < 2 && !subjectCaps, text: caps.length < 2 && !subjectCaps ? C.capsOk : fill(C.capsFound, { words: (subjectCaps ? [i.subject, ...caps] : caps).slice(0, 5).join(", ") }) },
    { kind: "exclaims", ok: bangs < 2 && !i.subject.includes("!"), text: bangs < 2 && !i.subject.includes("!") ? C.exclaimOk : fill(C.exclaimFound, { n: bangs }) },
  ];
  if (i.recipient !== undefined) {
    out.push({ kind: "recipient", ok: i.recipient === "verified", text: i.recipient === "verified" ? C.recipientOk : i.recipient === "domain_ok" ? C.recipientDomain : C.recipientUnknown });
  }
  return out;
}

/** True when the e-mail's own text (recipient aside) fails a check. */
export function hasContentProblem(m: Omit<ContentInput, "recipient">): boolean {
  return contentChecks(m, ptMessages).some((c) => !c.ok); // only ok/not ok is read: any language works
}
