import { senderComplete } from "@/lib/email/compose";
import { loadMailboxes, loadSender } from "@/lib/email/queries";
import { emailSession } from "@/lib/email/session";
import { CAMPAIGN_COLUMNS, type CampaignRow } from "@/lib/email/types";
import { EmailOverview, type OverviewMsg, type OverviewProspect, type OverviewReply } from "@/components/email/Overview";

/** The E-mail overview: loads as the logged-in user (RLS) and renders the view. */
export default async function EmailOverviewPage() {
  const s = await emailSession();
  if (!s) return null;
  const ws = s.workspace.id;
  const [sender, mailboxes, campaignsRes, lists, messagesRes, prospectsRes, repliesRes] = await Promise.all([
    loadSender(s.supabase, ws),
    loadMailboxes(s.supabase, ws),
    s.supabase.from("email_campaigns").select(CAMPAIGN_COLUMNS).eq("workspace_id", ws).order("created_at", { ascending: false }),
    s.supabase.from("research_lists").select("id, name").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(100),
    s.supabase.from("email_messages").select("id, campaign_id, prospect_id, kind, step, status, subject, body").eq("workspace_id", ws).limit(5000),
    s.supabase.from("email_prospects").select("id, campaign_id, company_name, contact_name, hook, status").eq("workspace_id", ws).limit(5000),
    s.supabase
      .from("email_replies")
      .select("id, prospect_id, subject, body_text, classification, class_reason, is_bounce, possible_bounce, received_at")
      .eq("workspace_id", ws)
      .order("received_at", { ascending: false })
      .limit(30),
  ]);
  return (
    <EmailOverview
      canSend={s.canSend}
      ready={senderComplete(sender) && mailboxes.length > 0}
      campaigns={(campaignsRes.data ?? []) as CampaignRow[]}
      messages={(messagesRes.data ?? []) as OverviewMsg[]}
      prospects={(prospectsRes.data ?? []) as OverviewProspect[]}
      replies={(repliesRes.data ?? []) as OverviewReply[]}
      mailboxes={mailboxes}
      lists={(lists.data ?? []) as { id: string; name: string }[]}
    />
  );
}
