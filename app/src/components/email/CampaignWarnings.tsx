import Link from "next/link";
import { loadMailboxes, loadSender } from "@/lib/email/queries";
import { campaignWarnings, hasContentProblem } from "@/lib/email/warnings";
import { t } from "@/messages/pt";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Warning strip at the top of Campanhas. Server component, read-only queries as the logged-in user (RLS). */
export async function CampaignWarnings({ db, workspaceId }: { db: SupabaseClient; workspaceId: string }) {
  const [mailboxes, campaigns, prospects, sent, c12, sender, links, drafts] = await Promise.all([
    loadMailboxes(db, workspaceId),
    db.from("email_campaigns").select("id, name, status, send_mode, agent_id").eq("workspace_id", workspaceId).neq("status", "archived"),
    db.from("email_prospects").select("campaign_id, status, stop_reason").eq("workspace_id", workspaceId).limit(5000),
    db.from("email_messages").select("campaign_id").eq("workspace_id", workspaceId).eq("kind", "sequence").eq("status", "sent").limit(5000),
    db.from("c12_approvals").select("item").eq("workspace_id", workspaceId),
    loadSender(db, workspaceId),
    db.from("campaign_mailboxes").select("campaign_id").eq("workspace_id", workspaceId),
    // drafts awaiting approval, for the local spam check (item 11); bounded like the other reads here
    db.from("email_messages").select("campaign_id, step, subject, body").eq("workspace_id", workspaceId).eq("kind", "sequence").eq("status", "draft").limit(500),
  ]);
  const count = (rows: { campaign_id: string }[] | null) => {
    const out: Record<string, number> = {};
    for (const r of rows ?? []) out[r.campaign_id] = (out[r.campaign_id] ?? 0) + 1;
    return out;
  };
  const ps = (prospects.data ?? []) as { campaign_id: string; status: string; stop_reason: string | null }[];
  const sentBy = count(sent.data as { campaign_id: string }[] | null);
  const linksBy = count(links.data as { campaign_id: string }[] | null);
  const bouncedBy = count(ps.filter((p) => p.stop_reason === "bounced"));
  const done = new Set(((c12.data ?? []) as { item: string }[]).map((r) => r.item));

  const warnings = campaignWarnings({
    mailboxes,
    campaigns: ((campaigns.data ?? []) as { id: string; name: string; status: string; send_mode: string; agent_id: string | null }[]).map((c) => ({ ...c, sent: sentBy[c.id] ?? 0, bounced: bouncedBy[c.id] ?? 0, mailbox_count: linksBy[c.id] ?? 0 })),
    sentToday: Object.fromEntries(mailboxes.map((m) => [m.id, m.usage?.real ?? 0])),
    prospectsByCampaign: count(ps.filter((p) => p.status === "active")),
    sender,
    gateOpen: Object.keys(t.email.c12.items).every((i) => done.has(i)),
    spamDrafts: count(((drafts.data ?? []) as { campaign_id: string; step: number | null; subject: string; body: string }[]).filter((m) => hasContentProblem(m))),
  });
  if (warnings.length === 0) return null;
  return (
    <ul aria-label={t.email.warnings.label} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {warnings.map((w, i) => (
        <li key={`${w.kind}-${i}`} className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          <Link href={w.href} className="underline">{w.text}</Link>
        </li>
      ))}
    </ul>
  );
}
