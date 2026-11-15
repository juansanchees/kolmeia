import { fill, t } from "@/messages/pt";

// Warning strip for Campanhas. Pure: the layout loads the rows, this decides what to say (read-only, no side effects).

export type CampaignWarning = {
  kind: "mailbox_error" | "mailbox_paused" | "no_leads" | "daily_limit" | "high_bounce" | "rehearsal_only";
  text: string;
  href: string;
};

export type WarningsInput = {
  mailboxes: { id: string; email: string; status: "unverified" | "ok" | "error"; health_status: "ok" | "paused_bounce"; daily_limit: number }[];
  /** sent / bounced = real sequence mails sent and prospects stopped by a bounce, per campaign. */
  campaigns: { id: string; name: string; status: string; send_mode: string; sent: number; bounced: number }[];
  /** Real mails sent today, by mailbox id. */
  sentToday: Record<string, number>;
  /** Active prospects, by campaign id. */
  prospectsByCampaign: Record<string, number>;
  /** C12 checklist complete (real sending allowed). */
  gateOpen: boolean;
};

const W = t.email.warnings;
const BOUNCE_MIN = 3; // same rule as the mailbox auto-pause (D7): >= 3 bounces and >= 5 %
const BOUNCE_RATE = 0.05;

export function campaignWarnings(i: WarningsInput): CampaignWarning[] {
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
  ];
}
