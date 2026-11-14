import { hasMailboxKey } from "@/lib/email/config";
import { senderComplete } from "@/lib/email/compose";
import { loadMailboxes, loadSender } from "@/lib/email/queries";
import { emailSession } from "@/lib/email/session";
import { removeMailbox, reverifyMailbox, sendTestMessage } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, Card, CardTitle, Label, Notice } from "@/components/email/bits";
import { ConnectMailboxForm, MailboxLimitForm, SenderForm } from "@/components/email/forms";
import { when } from "@/components/email/format";
import { fill, t } from "@/messages/pt";

const M = t.email;
const STATUS_TONE = { unverified: "cold", ok: "ok", error: "danger" } as const;

export default async function MailboxPage() {
  const s = await emailSession();
  if (!s) return null;
  const [sender, mailboxes] = await Promise.all([loadSender(s.supabase, s.workspace.id), loadMailboxes(s.supabase, s.workspace.id)]);
  const keyOk = hasMailboxKey();
  const isOwner = s.workspace.role === "owner";

  return (
    <div className="flex flex-wrap items-start gap-5">
      <Card aria-labelledby="sender-title" className="flex-[1_1_320px]">
        <CardTitle id="sender-title">{M.sender.title}</CardTitle>
        <p className="text-sm">{M.sender.intro}</p>
        {!senderComplete(sender) && <Notice>{M.sender.incomplete}</Notice>}
        <SenderForm initial={sender} disabled={!s.canSend} />
      </Card>

      <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
        <Card aria-labelledby="mb-title">
          <CardTitle id="mb-title">{M.mailbox.title}</CardTitle>
          {!keyOk && <Notice>{M.keyMissing}</Notice>}
          {mailboxes.length === 0 && <p className="text-sm text-muted">{M.mailbox.none}</p>}
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {mailboxes.map((m) => (
              <li key={m.id} className="flex min-w-0 flex-col gap-3 border border-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-semibold">{m.email}</span>
                  <Badge tone={STATUS_TONE[m.status]}>{M.mailbox.statuses[m.status]}</Badge>
                </div>
                {m.last_error && (
                  <p className="text-sm text-danger">
                    {m.last_error === "auth_failed" || m.last_error === "mailbox_secret" || m.last_error === "key_missing" ? M.mailbox.errors[m.last_error] : m.last_error}
                  </p>
                )}
                <div>
                  <Label>{M.mailbox.today}</Label>
                  <div className="text-sm">
                    {m.usage ? fill(M.mailbox.todayValue, { real: m.usage.real, dry: m.usage.dry_run, limit: m.usage.limit, test: m.usage.test ?? 0 }) : "?"}
                    {m.verified_at ? ` · ${when(m.verified_at)}` : ""}
                  </div>
                </div>
                {isOwner && <MailboxLimitForm mailboxId={m.id} limit={m.daily_limit} />}
                {s.canSend && (
                  <div className="flex flex-wrap items-start gap-2">
                    <ActionButton action={reverifyMailbox.bind(null, m.id)} label={M.mailbox.reverify} />
                    <ActionButton action={sendTestMessage.bind(null, m.id)} label={M.mailbox.sendTest} />
                    <ActionButton action={removeMailbox.bind(null, m.id)} label={M.mailbox.remove} variant="danger" confirm={M.mailbox.removeConfirm} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>

        {s.canSend && keyOk && (
          <Card aria-labelledby="connect-title">
            <CardTitle id="connect-title">{M.mailbox.connectTitle}</CardTitle>
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-sm">
              {M.mailbox.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="text-sm text-blue underline underline-offset-4">
              {M.mailbox.appPasswordLink} ↗
            </a>
            <ConnectMailboxForm />
          </Card>
        )}
      </div>
    </div>
  );
}
