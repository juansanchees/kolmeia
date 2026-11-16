import Link from "next/link";
import { loadMailboxes, loadSender, previewMessage } from "@/lib/email/queries";
import { replyTarget } from "@/lib/email/replies";
import { emailSession, previewOrigin } from "@/lib/email/session";
import { MESSAGE_COLUMNS, PROSPECT_COLUMNS, REPLY_COLUMNS, type MessageRow, type ProspectRow, type ReplyRow } from "@/lib/email/types";
import { confirmBounce, draftAnswerAction, handOffAction } from "../actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, Card, Label, Notice } from "@/components/email/bits";
import { when } from "@/components/email/format";
import { MessageEditor } from "@/components/email/MessageEditor";
import { FetchRepliesButton, ReplyLabelSelect, ReplySendButton } from "@/components/email/ReplyControls";
import { fill, t } from "@/messages/pt";
import { Paged } from "@/components/Pager";

const M = t.email;
const R = M.replies;

export default async function RepliesPage() {
  const s = await emailSession();
  if (!s) return null;
  const ws = s.workspace.id;
  const [repliesRes, mailboxes, sender, origin] = await Promise.all([
    s.supabase.from("email_replies").select(REPLY_COLUMNS).eq("workspace_id", ws).order("received_at", { ascending: false }).limit(100),
    loadMailboxes(s.supabase, ws),
    loadSender(s.supabase, ws),
    previewOrigin(),
  ]);
  const replies = (repliesRes.data ?? []) as ReplyRow[];
  const prospectIds = [...new Set(replies.map((r) => r.prospect_id).filter((x): x is string => Boolean(x)))];
  const [pRes, aRes] = prospectIds.length
    ? await Promise.all([
        s.supabase.from("email_prospects").select(PROSPECT_COLUMNS).in("id", prospectIds),
        s.supabase.from("email_messages").select(MESSAGE_COLUMNS).eq("kind", "reply").in("prospect_id", prospectIds),
      ])
    : [{ data: [] }, { data: [] }];
  const prospects = new Map(((pRes.data ?? []) as ProspectRow[]).map((p) => [p.id, p]));
  // the time a "come back later" message shows is read in the campaign's own time zone
  const campaignIds = [...new Set([...prospects.values()].map((p) => p.campaign_id))];
  const tzRes = campaignIds.length ? await s.supabase.from("email_campaigns").select("id, timezone").in("id", campaignIds) : { data: [] };
  const tzOf = new Map(((tzRes.data ?? []) as { id: string; timezone: string }[]).map((c) => [c.id, c.timezone]));
  const answers = (aRes.data ?? []) as MessageRow[];
  // the mailbox recorded on the answer, else the one the person is stuck to; the first mailbox only when none is recorded
  const fromOf = (m: MessageRow, p?: ProspectRow) => {
    const recorded = m.mailbox_id ?? p?.mailbox_id ?? null;
    return m.from_address ?? (recorded ? (mailboxes.find((b) => b.id === recorded)?.email ?? null) : (mailboxes[0]?.email ?? null));
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {s.canSend && (
        <Card aria-label={R.fetch}>
          <FetchRepliesButton mailboxes={mailboxes.filter((m) => m.status === "ok").map((m) => ({ id: m.id, email: m.email }))} />
          <p className="text-[13px] text-muted">
            {R.unsubscribeNote} {R.sendNote}
          </p>
        </Card>
      )}
      {replies.length === 0 && <p className="text-sm text-muted">{R.none}</p>}
      <Paged as="ul" className="m-0 flex list-none flex-col gap-4 p-0">
        {replies.map((r) => {
          const p = r.prospect_id ? prospects.get(r.prospect_id) : undefined;
          const mine = answers.filter((a) => a.reply_to_id === r.id);
          return (
            <li key={r.id}>
              <article className="flex min-w-0 flex-col gap-3 border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="m-0 break-words font-display text-xl uppercase">{p?.company_name ?? r.from_address}</h3>
                  <span className="font-mono text-xs text-muted">{when(r.received_at)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="break-all text-muted">
                    {R.from}: {r.from_address}
                  </span>
                  {r.is_bounce ? (
                    <Badge tone="warn">{R.bounce}</Badge>
                  ) : r.possible_bounce ? (
                    <Badge tone="warn">{R.possibleBounce}</Badge>
                  ) : r.classification ? (
                    <Badge tone={r.classification === "interested" ? "blue" : r.classification === "unsubscribe" ? "warn" : "cold"} title={r.class_reason ?? undefined}>
                      {R.labels[r.classification]}
                      {r.class_source === "ai" ? ` · ${R.labelHint}` : r.class_source === "rule" ? ` · ${R.labelRule}` : ""}
                    </Badge>
                  ) : null}
                  {p?.status === "handed_off" && <Badge tone="ink">{R.handedOff}</Badge>}
                </div>
                <div>
                  <Label>{r.subject}</Label>
                  {/* Untrusted text from the internet: rendered as plain text only (React escapes it; no HTML). */}
                  <p className="m-0 mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-sm" title={R.untrusted}>
                    {r.body_text}
                  </p>
                  {r.class_reason && (r.class_source === "ai" || r.class_source === "rule") && <p className="mt-1 text-[13px] text-muted">{r.class_reason}</p>}
                </div>
                {r.possible_bounce && (
                  <div className="flex flex-col gap-2 border border-warn-soft bg-warn-soft/40 p-3">
                    <p className="m-0 break-words text-sm">{fill(R.possibleBounceHelp, { email: r.bounced_address ?? p?.email ?? "?" })}</p>
                    {s.canSend && (
                      <div className="flex flex-wrap gap-2">
                        <ActionButton action={confirmBounce.bind(null, r.id, true)} label={R.confirmBounce} variant="danger" />
                        <ActionButton action={confirmBounce.bind(null, r.id, false)} label={R.notBounce} />
                      </div>
                    )}
                  </div>
                )}
                {!r.is_bounce && !r.possible_bounce && (
                  <div className="flex flex-wrap items-end gap-3">
                    <ReplyLabelSelect replyId={r.id} value={r.classification} disabled={!s.canSend} />
                    {s.canSend && mine.length === 0 && <ActionButton action={draftAnswerAction.bind(null, r.id)} label={R.draft} pendingLabel={R.drafting} />}
                    {s.canSend && p && p.status !== "handed_off" && p.status !== "stopped" && <ActionButton action={handOffAction.bind(null, p.id)} label={`${R.handOff} →`} variant="cta" />}
                    {p && (
                      <Link href={`/campanhas/${p.campaign_id}`} className="text-sm text-blue underline underline-offset-4">
                        {R.openCampaign}
                      </Link>
                    )}
                  </div>
                )}
                {mine.map((m) => {
                  // the answer goes to the replier when it is the prospect's own address or domain (R1: shown
                  // before approval, stamped on approval); otherwise to the prospect's address
                  const to = m.approved_to ?? m.to_address ?? (p ? replyTarget(r.from_address, p.email) : null);
                  const pv = p ? previewMessage(m, { email: to, unsub_token: p.unsub_token }, sender, fromOf(m, p), origin) : { preview: null, problem: "?" };
                  return (
                    <div key={`${m.id}-${m.updated_at}`} className="flex min-w-0 flex-col gap-2">
                      <MessageEditor
                        m={{ id: m.id, updatedAt: m.updated_at, toAddress: to, kind: m.kind, step: null, subject: m.subject, body: m.body, status: m.status, ai_drafted: m.ai_drafted, human_edited: m.human_edited, dueText: m.sent_at ? when(m.sent_at) : "", preview: pv.preview, previewProblem: pv.problem }}
                        canSend={s.canSend}
                      />
                      {s.canSend && m.status === "approved" && <ReplySendButton messageId={m.id} timezone={p ? tzOf.get(p.campaign_id) : undefined} />}
                    </div>
                  );
                })}
              </article>
            </li>
          );
        })}
      </Paged>
      {mailboxes.length > 0 && mailboxes.every((m) => m.status !== "ok") && <Notice>{M.send.outcomes.mailbox_not_verified}</Notice>}
    </div>
  );
}
