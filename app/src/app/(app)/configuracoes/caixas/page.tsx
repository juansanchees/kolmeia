import { notFound } from "next/navigation";
import { isSender } from "@/lib/roles";
import { hasMailboxKey } from "@/lib/email/config";
import { senderComplete } from "@/lib/email/compose";
import { loadMailboxes, loadSender } from "@/lib/email/queries";
import { emailSession } from "@/lib/email/session";
import { clearMailboxPause, removeMailbox, reverifyMailbox, sendTestMessage } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Label } from "@/components/email/bits";
import { Badge, EmptyState, HexPanel, Notice, StepTitle } from "@/components/ui";
import { ConnectMailboxForm, MailboxLimitForm, SenderForm } from "@/components/email/forms";
import { when } from "@/components/email/format";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const STATUS_TONE = { unverified: "neutral", ok: "ok", error: "danger" } as const;

/** E4 (0024): mailbox_usage also answers the real limit of today (warm-up ramp). */
type UsageWithRamp = { real_limit?: number } | null;

export default async function MailboxPage() {
  const t = await getT();
  const M = t.email;
  const s = await emailSession();
  if (!s) return null;
  if (!isSender(s.workspace.role)) notFound();
  const [sender, mailboxes] = await Promise.all([loadSender(s.supabase, s.workspace.id), loadMailboxes(s.supabase, s.workspace.id)]);
  const keyOk = hasMailboxKey();
  const isOwner = s.workspace.role === "owner";

  return (
    <div className="flex flex-wrap items-start gap-5">
      <HexPanel as="section" aria-labelledby="sender-title" wrapClassName="k-in flex-[1_1_320px]" className="flex flex-col gap-4 py-6">
        <StepTitle n={1} hint={M.sender.intro}><span id="sender-title">{M.sender.title}</span></StepTitle>
        {!senderComplete(sender) && <Notice tone="warn">{M.sender.incomplete}</Notice>}
        <SenderForm initial={sender} disabled={!s.canSend} />
      </HexPanel>

      <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5">
        <HexPanel as="section" aria-labelledby="mb-title" wrapClassName="k-in" className="flex flex-col gap-4 py-6">
          <div id="mb-title"><StepTitle n={2}>{M.mailbox.title}</StepTitle></div>
          {!keyOk && <Notice tone="warn">{M.keyMissing}</Notice>}
          {mailboxes.length === 0 && <EmptyState title={M.mailbox.none} className="py-6" />}
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {mailboxes.map((m) => (
              <li key={m.id} className="flex min-w-0 flex-col gap-3 rounded-[14px] border-2 border-line p-4 hover:border-honey-edge hover:bg-[#fffaeb]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-semibold">{m.email}</span>
                  <span className="flex flex-wrap gap-2">
                    <Badge tone={STATUS_TONE[m.status]}>{M.mailbox.statuses[m.status]}</Badge>
                    <Badge tone={m.health_status === "ok" ? "ok" : "danger"} title={m.paused_reason ?? undefined}>{M.mailbox.health[m.health_status]}</Badge>
                  </span>
                </div>
                {m.health_status === "paused_bounce" && (
                  <div className="flex flex-col gap-2">
                    <Notice tone="warn" role="alert">
                      {M.mailbox.pausedHint}
                      {m.paused_reason ? ` (${m.paused_reason}${m.paused_at ? ` · ${when(m.paused_at, t.intl)}` : ""})` : ""}
                    </Notice>
                    {isOwner && <ActionButton action={clearMailboxPause.bind(null, m.id)} label={M.mailbox.clearPause} confirm={M.mailbox.clearPauseConfirm} />}
                  </div>
                )}
                {m.last_error && (
                  <p className="text-sm text-danger">
                    {m.last_error === "auth_failed" || m.last_error === "mailbox_secret" || m.last_error === "key_missing" ? M.mailbox.errors[m.last_error] : m.last_error}
                  </p>
                )}
                <div>
                  <Label>{M.mailbox.today}</Label>
                  <div className="text-sm">
                    {m.usage ? fill(M.mailbox.todayValue, { real: m.usage.real, dry: m.usage.dry_run, limit: m.usage.limit, test: m.usage.test ?? 0 }) : "?"}
                    {m.verified_at ? ` · ${when(m.verified_at, t.intl)}` : ""}
                  </div>
                </div>
                <div>
                  <Label>{M.mailbox.ramp}</Label>
                  <div className="text-sm">
                    {!m.ramp_enabled
                      ? fill(M.mailbox.rampOff, { limit: m.daily_limit })
                      : fill(M.mailbox.rampValue, {
                          today: (m.usage as UsageWithRamp)?.real_limit ?? "?",
                          start: m.ramp_start,
                          step: m.ramp_step,
                          limit: m.daily_limit,
                        }) + (m.ramp_started_at ? ` · ${when(m.ramp_started_at, t.intl)}` : ` · ${M.mailbox.rampNotStarted}`)}
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
        </HexPanel>

        {s.canSend && keyOk && (
          <HexPanel as="section" aria-labelledby="connect-title" wrapClassName="k-in" className="flex flex-col gap-4 py-6">
            <div id="connect-title"><StepTitle n={3}>{M.mailbox.connectTitle}</StepTitle></div>
            <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-base">
              {M.mailbox.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="text-base font-medium text-ink underline decoration-honey decoration-2 underline-offset-4">
              {M.mailbox.appPasswordLink} ↗
            </a>
            <ConnectMailboxForm />
          </HexPanel>
        )}
      </div>
    </div>
  );
}
