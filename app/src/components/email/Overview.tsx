import Link from "next/link";
import type { MailboxWithUsage } from "@/lib/email/queries";
import type { CampaignRow, ReplyClass } from "@/lib/email/types";
import { handOffAction, pauseAllCampaigns } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "./ActionButton";
import { Badge, NextStep, Panel } from "./bits";
import { buttonClass, CountPill, EmptyState, HexLink, HexPanel, Chevron } from "@/components/ui";
import { timeOf } from "./format";
import { NewCampaignForm } from "./forms";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";

export type OverviewMsg = { id: string; campaign_id: string; prospect_id: string; kind: string; step: number | null; status: string; subject: string; body: string };
export type OverviewProspect = { id: string; campaign_id: string; company_name: string; contact_name: string | null; hook: string | null; status: string };
export type OverviewReply = { id: string; prospect_id: string | null; subject: string; body_text: string; classification: ReplyClass | null; class_reason: string | null; is_bounce: boolean; possible_bounce: boolean; received_at: string };

export type OverviewData = {
  canSend: boolean;
  ready: boolean;
  campaigns: CampaignRow[];
  messages: OverviewMsg[];
  prospects: OverviewProspect[];
  replies: OverviewReply[];
  mailboxes: MailboxWithUsage[];
  lists: { id: string; name: string }[];
};

/**
 * The E-mail overview (approved prototype docs/mvp/prototipo/Email.dc.html): today's sending at the top, then
 * three columns: campaigns (lists from Pesquisa), what waits for approval, and replies to answer. Pure view.
 */
export async function EmailOverview(d: OverviewData) {
  const t = await getT();
  const M = t.email;
  const O = M.overview;
  const s = { canSend: d.canSend };
  const mailboxes = d.mailboxes;
  const ready = d.ready;
  const listRows = d.lists;
  const campaigns = d.campaigns;
  const messages = d.messages;
  const prospects = new Map(d.prospects.map((p) => [p.id, p]));
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const live = campaigns.filter((c) => c.status !== "archived");
  const archived = campaigns.filter((c) => c.status === "archived");
  const count = (id: string, pred: (m: OverviewMsg) => boolean) => messages.filter((m) => m.campaign_id === id && pred(m)).length;

  // today's sending: the mailbox of the most recent sending campaign, else the first one
  const activeBox = live.find((c) => c.status === "active")?.mailbox_id;
  const box = mailboxes.find((m) => m.id === activeBox) ?? mailboxes[0] ?? null;
  const usage = box?.usage ?? null;
  const atLimit = usage ? usage.real >= usage.limit : false;

  // waiting for approval: companies with sequence drafts, oldest campaign first
  const waiting = new Map<string, OverviewMsg[]>();
  for (const m of messages) {
    if (m.kind !== "sequence" || m.status !== "draft") continue;
    if (prospects.get(m.prospect_id)?.status !== "active") continue;
    waiting.set(m.prospect_id, [...(waiting.get(m.prospect_id) ?? []), m].sort((a, b) => (a.step ?? 0) - (b.step ?? 0)));
  }
  const queue = [...waiting.entries()].slice(0, 6);
  const first = queue[0];

  // replies to answer: people (not bounces) whose company is still with us
  const replies = d.replies.filter((r) => !r.is_bounce && !r.possible_bounce && r.prospect_id && prospects.get(r.prospect_id)?.status === "replied").slice(0, 4);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {!ready && s.canSend && (
        <NextStep label={M.campaign.nextStep}>
          <p className="m-0 text-lg font-semibold">{M.campaigns.setupFirst}</p>
          <div>
            <HexLink href="/configuracoes/caixas">
              {M.campaigns.setupLink} <Chevron className="k-arrow" />
            </HexLink>
          </div>
        </NextStep>
      )}

      <HexPanel as="section" aria-label={O.today} c={18} cSm={10} wrapClassName="k-in" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
        {box && usage ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-7 gap-y-2">
            <span className="text-base">
              <span className="font-display text-[30px] font-bold">{usage.real}</span> {fill(O.sentToday, { limit: usage.limit })}
            </span>
            {usage.dry_run > 0 && <span className="text-[15px] text-[#4a5361]">{fill(O.rehearsedToday, { n: usage.dry_run })}</span>}
            {usage.next_at && <span className="text-[15px] text-[#4a5361]">{fill(O.nextAt, { time: timeOf(usage.next_at, t.intl).slice(0, 5) })}</span>}
            <span className="break-all text-[15px] text-[#4a5361]">{fill(O.mailbox, { email: box.email })}</span>
            <Badge tone={atLimit ? "warn" : "ok"}>{atLimit ? O.atLimit : O.withinLimit}</Badge>
          </div>
        ) : (
          <span className="text-base text-[#4a5361]">{O.noMailbox}</span>
        )}
        {s.canSend && live.some((c) => c.status === "active") && (
          <ActionButton action={pauseAllCampaigns} label={O.pauseAll} variant="danger" confirm={O.pauseAllConfirm} />
        )}
      </HexPanel>

      <div className="flex flex-wrap items-start gap-5">
        <Panel id="ov-lists" title={O.lists} hint={O.listsHint} className="k-in flex-[1_1_260px]">
          {live.length === 0 && (
            <div className="p-4">
              <EmptyState title={M.campaigns.none}>{M.ui.noCampaignsNext}</EmptyState>
            </div>
          )}
          <Paged as="ul" className="m-0 flex list-none flex-col gap-2.5 p-4 empty:hidden">
            {live.map((c) => {
              const sending = c.status === "active";
              return (
                <li key={c.id}>
                  <Link
                    href={`/campanhas/${c.id}`}
                    className={`k-btn flex min-w-0 flex-col gap-2 rounded-[14px] border-2 px-4 py-3.5 text-ink no-underline hover:border-honey-edge hover:bg-honey-hover ${sending ? "border-honey-edge bg-honey-soft" : "border-[#e3e6ec] bg-surface"}`}
                  >
                    <span className="break-words text-base font-semibold">{c.name}</span>
                    <span className="flex flex-wrap gap-1.5">
                      <Badge tone={sending ? "ok" : c.status === "paused" ? "warn" : "cold"}>{M.campaigns.status[c.status]}</Badge>
                      <Badge tone={c.send_mode === "real" ? "ink" : "soft"}>{M.campaigns.mode[c.send_mode]}</Badge>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[15px] text-[#4a5361]">
                      <span className="inline-flex items-center gap-1.5">
                        <CountPill>{[...prospects.values()].filter((p) => p.campaign_id === c.id).length}</CountPill> {M.ui.counts.prospects}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <CountPill>{count(c.id, (m) => m.status === "approved")}</CountPill> {M.ui.counts.approved}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <CountPill tone="honey">{count(c.id, (m) => m.status === "sent" || m.status === "dry_run")}</CountPill> {M.ui.counts.sent}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </Paged>
          {archived.length > 0 && (
            <details className="border-t border-[#e3e6ec] px-4 py-3">
              <summary className="min-h-11 content-center text-[15px] text-[#4a5361]">
                {O.archived} <CountPill tone="cold">{archived.length}</CountPill>
              </summary>
              <Paged as="ul" className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
                {archived.map((c) => (
                  <li key={c.id}>
                    <Link href={`/campanhas/${c.id}`} className="k-link break-words text-[15px] underline">
                      {c.name}
                    </Link>
                  </li>
                ))}
              </Paged>
            </details>
          )}
          {s.canSend && ready && (
            <details className="border-t border-[#e3e6ec] px-4 py-3.5" open={live.length === 0}>
              <summary className="min-h-11 content-center text-base font-semibold text-ink">+ {M.campaigns.newTitle}</summary>
              <div className="mt-3 flex flex-col gap-3">
              {listRows.length === 0 ? (
                <p className="m-0 text-[15px]">
                  {M.campaigns.noLists}{" "}
                  <Link href="/agentes" className="k-link underline">
                    {t.research.title}
                  </Link>
                </p>
              ) : (
                <NewCampaignForm lists={listRows} mailboxes={mailboxes.map((m) => ({ id: m.id, email: m.email }))} />
              )}
              </div>
            </details>
          )}
          <Link href="/agentes" className="k-link m-1.5 rounded-xl px-2.5 py-3.5 text-[15px] font-semibold underline">
            + {O.newResearch}
          </Link>
        </Panel>

        <Panel id="ov-approve" title={O.approve} hint={fill(O.waiting, { n: waiting.size })} className="k-in flex-[999_1_420px] [animation-delay:.06s]">
          {!first && (
            <div className="p-4">
              <EmptyState title={O.nothingToApprove}>{M.ui.nothingToApproveNext}</EmptyState>
            </div>
          )}
          {first &&
            (() => {
              const [pid, ms] = first;
              const p = prospects.get(pid)!;
              const m = ms[0];
              return (
                <div className="flex min-w-0 flex-col gap-2.5 border-b border-[#e3e6ec] p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="break-words text-base font-semibold">{p.company_name}</span>
                    <span className="font-mono text-[13px] text-[#4a5361]">
                      {fill(O.stepOf, { n: m.step ?? 1 })} · {campaignName.get(p.campaign_id)}
                    </span>
                  </div>
                  {p.hook && <div className="rounded-[10px] bg-honey-soft px-3 py-2 text-[15px] text-ink">{p.hook}</div>}
                  <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{M.review.body}</span>
                  <p className="m-0 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-[12px] border-2 border-line p-3 text-base leading-relaxed">{m.body}</p>
                  {s.canSend && (
                    <div>
                      <Link href={`/campanhas/${p.campaign_id}/revisar?p=${pid}`} className={buttonClass("primary")}>
                        {M.campaign.steps.review.replace(/\.$/, "")} <Chevron className="k-arrow" />
                      </Link>
                    </div>
                  )}
                </div>
              );
            })()}
          <Paged>
          {queue.slice(1).map(([pid, ms]) => {
            const p = prospects.get(pid)!;
            return (
              <div key={pid} className="k-row flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[#e3e6ec] px-4 py-3.5">
                <div className="min-w-0">
                  <div className="break-words text-base font-semibold">{p.company_name}</div>
                  <div className="font-mono text-[13px] text-[#4a5361]">
                    {fill(O.stepOf, { n: ms[0].step ?? 1 })} · {campaignName.get(p.campaign_id)}
                  </div>
                </div>
                <Link href={`/campanhas/${p.campaign_id}/revisar?p=${pid}`} className={buttonClass("secondary", "sm")}>
                  {O.open}
                </Link>
              </div>
            );
          })}
          </Paged>
        </Panel>

        <Panel id="ov-replies" title={O.replies} hint={fill(O.newN, { n: replies.length })} className="k-in flex-[1_1_300px] [animation-delay:.12s]">
          {replies.length === 0 && (
            <div className="p-4">
              <EmptyState title={O.noReplies}>{M.ui.noRepliesNext}</EmptyState>
            </div>
          )}
          <Paged>
          {replies.map((r) => {
            const p = prospects.get(r.prospect_id!)!;
            const firstLine = r.body_text.split(/\n+/).find((l) => l.trim()) ?? r.subject;
            const hot = r.classification === "interested";
            return (
              <div key={r.id} className={`flex min-w-0 flex-col gap-2 border-b border-[#e3e6ec] p-4 ${hot ? "bg-honey-soft" : ""}`}>
                <div className="break-words text-base font-semibold">{p.company_name}</div>
                {r.classification && (
                  <span>
                    <Badge tone={hot ? "blue" : r.classification === "unsubscribe" ? "warn" : "cold"}>{M.replies.labels[r.classification]}</Badge>
                  </span>
                )}
                {/* text received from the internet: plain text only */}
                <p className="m-0 break-words text-[15px] text-cold-ink">“{firstLine.slice(0, 200)}”</p>
                {r.class_reason && <p className="m-0 text-[14px] text-[#4a5361]">{r.class_reason}</p>}
                <Link href="/campanhas/respostas" className={`${buttonClass("secondary", "sm")} self-start`}>
                  {O.seeAll}
                </Link>
                {s.canSend && <ActionButton action={handOffAction.bind(null, p.id)} label={`${M.replies.handOff} →`} variant="cta" />}
              </div>
            );
          })}
          </Paged>
          <p className="m-0 px-4 py-3.5 text-[14px] text-[#4a5361]">{O.unsubNote}</p>
        </Panel>
      </div>
    </div>
  );
}
