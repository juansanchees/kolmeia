import { reserveFor } from "@/lib/ai/gateway";
import { sequenceDef } from "@/lib/ai/email-tasks";
import { hasAi } from "@/lib/ai/config";
import { MAILBOX_COLUMNS, type MailboxRow } from "@/lib/email/types";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { EmailAgentWizard } from "@/components/agents/EmailAgentWizard";

export default async function NewEmailAgentPage() {
  const ws = await requireSender();
  const db = await createClient();
  let mailboxes: Pick<MailboxRow, "id" | "email" | "status">[] = [];
  let hunters: { id: string; name: string }[] = [];
  if (db) {
    const [m, a] = await Promise.all([
      db.from("mailboxes").select(MAILBOX_COLUMNS).eq("workspace_id", ws.id).order("created_at", { ascending: true }),
      db.from("agents").select("id, name").eq("workspace_id", ws.id).eq("type", "hunter").is("archived_at", null).order("created_at", { ascending: true }),
    ]);
    mailboxes = ((m.data ?? []) as MailboxRow[]).map(({ id, email, status }) => ({ id, email, status }));
    hunters = (a.data ?? []) as { id: string; name: string }[];
  }
  // what the one AI call may cost at most (its reservation); shown before the click
  return <EmailAgentWizard mailboxes={mailboxes} hunters={hunters} ai={hasAi()} estimateUsd={reserveFor(sequenceDef)} />;
}
