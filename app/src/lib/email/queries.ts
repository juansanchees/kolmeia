import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ComposeError, composeEmail, unsubscribeUrls } from "./compose";
import { MAILBOX_COLUMNS, type MailboxRow, type MessageRow, type ProspectRow, type SenderProfile } from "./types";

// Read helpers for the E-mail screens (the logged-in user's session; RLS applies).

export type MailboxWithUsage = MailboxRow & {
  usage: { real: number; dry_run: number; test: number; limit: number; test_limit: number; next_at: string | null } | null;
};

export async function loadMailboxes(db: SupabaseClient, workspaceId: string): Promise<MailboxWithUsage[]> {
  const { data } = await db.from("mailboxes").select(MAILBOX_COLUMNS).eq("workspace_id", workspaceId).order("created_at", { ascending: true });
  const rows = (data ?? []) as MailboxRow[];
  return Promise.all(
    rows.map(async (m) => {
      const { data: usage } = await db.rpc("mailbox_usage", { p_mailbox: m.id });
      return { ...m, usage: (usage as MailboxWithUsage["usage"]) ?? null };
    }),
  );
}

export async function loadSender(db: SupabaseClient, workspaceId: string): Promise<SenderProfile> {
  const { data } = await db.from("sender_profiles").select("legal_name, postal_address, sender_name").eq("workspace_id", workspaceId).maybeSingle();
  return (data as SenderProfile | null) ?? { legal_name: "", postal_address: "", sender_name: "" };
}

/**
 * The exact final text of a message as it would leave now (body + CAN-SPAM footer), built by the same composer the
 * sender uses. A placeholder Message-ID is used for the preview; the real one is stamped at claim time.
 */
export function previewMessage(
  m: Pick<MessageRow, "kind" | "subject" | "body" | "in_reply_to">,
  p: Pick<ProspectRow, "email" | "unsub_token">,
  sender: SenderProfile,
  fromAddress: string | null,
  origin: string,
): { preview: string | null; problem: string | null } {
  try {
    const mail = composeEmail({
      kind: m.kind,
      sender,
      fromAddress: fromAddress ?? "",
      to: p.email ?? "",
      subject: m.subject,
      body: m.body,
      unsubscribe: unsubscribeUrls(origin, p.unsub_token),
      messageId: "<preview@local>",
      inReplyTo: m.in_reply_to,
    });
    const head = [
      `From: ${mail.from.name} <${mail.from.address}>`,
      `To: ${mail.to}`,
      `Subject: ${mail.subject}`,
      `List-Unsubscribe: ${mail.headers["List-Unsubscribe"]}`,
      `List-Unsubscribe-Post: ${mail.headers["List-Unsubscribe-Post"]}`,
    ].join("\n");
    return { preview: `${head}\n\n${mail.text}`, problem: null };
  } catch (e) {
    return { preview: null, problem: e instanceof ComposeError ? e.code : "?" };
  }
}

export type SendSummary = {
  waiting_approval: number;
  approved_due: number;
  scheduled: number;
  no_address: number;
  suppressed: number;
  sent: number;
  dry_run: number;
  failed: number;
  cancelled: number;
};

const STOPPED = new Set(["suppressed", "unsubscribed", "bounced", "asked_to_stop", "in_other_campaign", "lead_discarded", "do_not_call", "lead_status"]);

export function summarize(messages: MessageRow[], prospects: ProspectRow[], now = Date.now()): SendSummary {
  const active = new Map(prospects.map((p) => [p.id, p]));
  const s: SendSummary = { waiting_approval: 0, approved_due: 0, scheduled: 0, no_address: 0, suppressed: 0, sent: 0, dry_run: 0, failed: 0, cancelled: 0 };
  for (const m of messages) {
    const due = m.due_at ? new Date(m.due_at).getTime() <= now : false;
    switch (m.status) {
      case "draft":
      case "rejected":
        if (active.get(m.prospect_id)?.status === "active" || m.kind === "reply") s.waiting_approval++;
        break;
      case "approved":
        if (due) s.approved_due++;
        else s.scheduled++;
        break;
      case "sent":
        s.sent++;
        break;
      case "dry_run":
        s.dry_run++;
        break;
      case "failed":
        s.failed++;
        break;
      case "cancelled":
        if (m.cancel_reason && STOPPED.has(m.cancel_reason)) s.suppressed++;
        else s.cancelled++;
        break;
    }
  }
  s.no_address = prospects.filter((p) => p.status === "active" && !p.email).length;
  return s;
}
