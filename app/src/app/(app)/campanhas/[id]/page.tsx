import Link from "next/link";
import { notFound } from "next/navigation";
import { hasAi } from "@/lib/ai/config";
import { senderComplete } from "@/lib/email/compose";
import { loadMailboxes, loadSender, summarize } from "@/lib/email/queries";
import { sentTodayByAddress } from "@/lib/email/rotation";
import { localDayStart, scheduleParts } from "@/lib/email/schedule";
import { emailSession } from "@/lib/email/session";
import { CAMPAIGN_COLUMNS, MESSAGE_COLUMNS, PROSPECT_COLUMNS, type CampaignRow, type MessageRow, type ProspectRow } from "@/lib/email/types";
import { confirmSuggestedEmail, retryMessage, setCampaignStatus, setProspectSkipped, setSendMode, writeTemplateDrafts } from "../actions";
import { ActionButton } from "@/components/email/ActionButton";
import { REAL_SEND_ENV_NAME } from "@/lib/email/config";
import { C12Checklist, type C12Approval } from "@/components/email/C12Checklist";
import { Badge, Card, Label, Notice } from "@/components/email/bits";
import { Chevron, CountPill, HexLink, HexPanel, StepTitle } from "@/components/ui";
import { DraftDriver, SendDriver } from "@/components/email/Drivers";
import { FetchRepliesButton } from "@/components/email/ReplyControls";
import { CampaignMailboxesForm, DelaysForm, ProspectEmailForm } from "@/components/email/forms";
import { STATUS_TONE } from "@/components/email/MessageEditor";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const M = t.email;
  const C = M.campaign;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await emailSession();
  if (!s) notFound();
  const { data: campaignData } = await s.supabase.from("email_campaigns").select(CAMPAIGN_COLUMNS).eq("id", id).maybeSingle();
  if (!campaignData) notFound();
  const campaign = campaignData as CampaignRow;
  const [prospectsRes, messagesRes, sender, mailboxes, listRes, sentRes, c12Res] = await Promise.all([
    s.supabase.from("email_prospects").select(PROSPECT_COLUMNS).eq("campaign_id", id).order("created_at", { ascending: true }),
    s.supabase.from("email_messages").select(MESSAGE_COLUMNS).eq("campaign_id", id).order("created_at", { ascending: true }),
    loadSender(s.supabase, campaign.workspace_id),
    loadMailboxes(s.supabase, campaign.workspace_id),
    s.supabase.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", id).order("seq", { ascending: true }),
    s.supabase.from("email_send_log").select("mailbox_address").eq("mode", campaign.send_mode).gt("claimed_at", localDayStart(campaign.timezone, new Date()).toISOString()),
    // C12 (0018): owner and sdr read the checklist; a closer gets no rows
    s.supabase.from("c12_approvals").select("item, evidence, approved_at").eq("workspace_id", campaign.workspace_id),
  ]);
  // 0025: the owner's switch for real sends by the clock (read-only here; set_clock_real writes it)
  const { data: clockRow } = await s.supabase.from("workspace_settings").select("clock_real_enabled, clock_real_set_at, clock_real_set_by").eq("workspace_id", campaign.workspace_id).maybeSingle();
  const clock = { enabled: clockRow?.clock_real_enabled === true, setAt: (clockRow?.clock_real_set_at as string | null) ?? null, setBy: (clockRow?.clock_real_set_by as string | null) ?? null };
  // a campaign with a sequence takes its delays from the approved version (set_campaign_delays refuses them)
  const { count: sequenceCount } = await s.supabase.from("email_sequences").select("id", { count: "exact", head: true }).eq("campaign_id", id);
  const hasSequence = (sequenceCount ?? 0) > 0;
  const prospects = (prospectsRes.data ?? []) as ProspectRow[];
  const messages = (messagesRes.data ?? []) as MessageRow[];
  const byProspect = new Map<string, MessageRow[]>();
  for (const m of messages) byProspect.set(m.prospect_id, [...(byProspect.get(m.prospect_id) ?? []), m]);

  const ai = hasAi();
  const toDraft = prospects.filter((p) => p.status === "active" && p.email && !(byProspect.get(p.id) ?? []).some((m) => m.kind === "sequence")).length;
  const noEmail = prospects.filter((p) => p.status === "active" && !p.email).length;
  const summary = summarize(messages, prospects);
  // E3: the campaign's own list (screen order); the send log counts per address across campaigns, like the limits
  const selected = ((listRes.data ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id);
  const chosen = selected.map((mid) => mailboxes.find((m) => m.id === mid)).filter((m): m is (typeof mailboxes)[number] => Boolean(m));
  const sentToday = sentTodayByAddress((sentRes.data ?? []) as { mailbox_address: string }[]);
  const mailboxOptions = mailboxes.map((m) => ({ id: m.id, email: m.email, status: m.status, sentToday: sentToday[m.email] ?? 0 }));
  const c12 = (c12Res.data ?? []) as C12Approval[];
  const c12Ready = Object.keys(t.email.c12.items).every((item) => c12.some((a) => a.item === item));
  const realReady = Boolean(chosen.some((m) => m.status === "ok") && senderComplete(sender) && c12Ready);
  const failed = messages.filter((m) => m.status === "failed");

  const archived = campaign.status === "archived";
  const step: keyof typeof C.steps =
    toDraft > 0 ? "draft" : summary.waiting_approval > 0 ? "review" : noEmail > 0 ? "emails" : campaign.status === "draft" ? "start" : campaign.status === "active" && summary.approved_due > 0 ? "send" : campaign.status === "active" ? "waiting" : "start";

  // numbered sections: the next step and the checklist only show to those who can send
  const showNext = s.canSend && !archived;
  const nSummary = showNext ? 2 : 1;
  const nMode = nSummary + 1;
  const nC12 = nMode + 1;
  const nPros = s.canSend ? nC12 + 1 : nMode + 1;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="k-in flex flex-col gap-2">
        <Link href="/campanhas" className="k-link self-start text-[15px] underline">
          {C.back}
        </Link>
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="break-words text-3xl">{campaign.name}</h2>
          <Badge tone={campaign.status === "active" ? "blue" : archived ? "warn" : "cold"}>{M.campaigns.status[campaign.status]}</Badge>
          <Badge tone={campaign.send_mode === "real" ? "ink" : "soft"}>{M.campaigns.mode[campaign.send_mode]}</Badge>
        </div>
        <p className="m-0 break-all font-mono text-[13px] text-[#4a5361]">{chosen.length ? chosen.map((m) => m.email).join(" · ") : M.send.outcomes.no_mailbox}</p>
        <p className="m-0 text-[15px] text-[#4a5361]">{fill(C.schedule, scheduleParts(campaign, t))}</p>
      </div>

      {archived && <Notice tone="info">{C.archivedNotice}</Notice>}

      {showNext && (
        <section aria-labelledby="next-title" className="k-step flex flex-col gap-3">
          <StepTitle n={1} hint={M.ui.detail.nextHint}>
            <span id="next-title">{C.nextStep}</span>
          </StepTitle>
          <HexPanel tone="honey" c={20} cSm={10} wrapClassName="k-in" className="flex flex-col gap-3 py-5">
            <p className="m-0 text-lg font-semibold">{C.steps[step]}</p>
            {step === "draft" &&
              (ai ? (
                <DraftDriver campaignId={id} remaining={toDraft} autoStart />
              ) : (
                <>
                  <Notice>{M.ai.not_configured}</Notice>
                  <div>
                    <ActionButton action={writeTemplateDrafts.bind(null, id)} label={C.templates} variant="primary" />
                  </div>
                </>
              ))}
            {step === "review" && (
              <div>
                <HexLink href={`/campanhas/${id}/revisar`}>
                  {fill(C.reviewLink, { n: summary.waiting_approval })} <Chevron className="k-arrow" />
                </HexLink>
              </div>
            )}
            {step === "emails" && <p className="m-0 text-base">{`${noEmail} ${C.noEmail}`}</p>}
            {step === "start" && campaign.status === "draft" && (
              <div>
                <ActionButton action={setCampaignStatus.bind(null, id, "active")} label={C.start} variant="primary" />
              </div>
            )}
            {step === "start" && campaign.status === "paused" && (
              <div>
                <ActionButton action={setCampaignStatus.bind(null, id, "active")} label={C.resume} variant="primary" />
              </div>
            )}
            {(step === "send" || step === "waiting") && <SendDriver campaignId={id} timezone={campaign.timezone} />}
          </HexPanel>
        </section>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <section aria-labelledby="sum-title" className="k-step flex min-w-0 flex-[1_1_300px] flex-col gap-3">
          <StepTitle n={nSummary} hint={M.ui.detail.summaryHint}>
            <span id="sum-title">{M.send.summary}</span>
          </StepTitle>
          <Card>
            <dl className="m-0 flex flex-col gap-2 text-[15px]">
              {(Object.keys(M.send.blocked) as (keyof typeof M.send.blocked)[]).map((k) => (
                <div key={k} className="flex items-center gap-2.5">
                  <dt className="shrink-0">
                    <CountPill tone={summary[k] > 0 ? "soft" : "cold"}>{summary[k]}</CountPill>
                  </dt>
                  <dd className="m-0">{M.send.blocked[k]}</dd>
                </div>
              ))}
            </dl>
            {failed.length > 0 && s.canSend && (
              <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
                {failed.map((m) => {
                  // R9: a real claim whose result is unknown may already be in the inbox: retry only after checking
                  const unknown = m.error === "interrupted" && m.send_mode === "real";
                  return (
                    <li key={m.id} className="flex min-w-0 flex-col gap-1.5 rounded-[12px] border-2 border-[#f1b0ab] bg-[#fde8e7]/40 p-3 text-[15px]">
                      <span className="break-words font-semibold">
                        {prospects.find((p) => p.id === m.prospect_id)?.company_name} · {fill(M.review.step, { n: m.step ?? 1 })}
                      </span>
                      {m.error === "interrupted" ? (
                        <span className="text-warn">{M.send.interrupted}</span>
                      ) : (
                        <span className="break-all font-mono text-[13px] text-danger">{m.error}</span>
                      )}
                      {unknown ? (
                        <ActionButton action={retryMessage.bind(null, m.id, true)} label={M.send.retryInterrupted} confirm={M.send.retryInterruptedConfirm} />
                      ) : (
                        <ActionButton action={retryMessage.bind(null, m.id, false)} label={M.send.retry} />
                      )}
                    </li>
                  );
                })}
              </Paged>
            )}
            {s.canSend && !archived && (
              <div className="flex flex-wrap gap-2 border-t border-[#e3e6ec] pt-3">
                {campaign.status === "active" && <ActionButton action={setCampaignStatus.bind(null, id, "paused")} label={C.pause} />}
                {campaign.status === "paused" && <ActionButton action={setCampaignStatus.bind(null, id, "active")} label={C.resume} />}
                {campaign.status !== "done" && campaign.status !== "draft" && <ActionButton action={setCampaignStatus.bind(null, id, "done")} label={C.finish} confirm={C.finish + "?"} />}
                <ActionButton action={setCampaignStatus.bind(null, id, "archived")} label={C.archive} variant="danger" confirm={C.archiveConfirm} />
              </div>
            )}
          </Card>
        </section>

        <section aria-labelledby="mode-title" className="k-step flex min-w-0 flex-[1_1_300px] flex-col gap-3">
          <StepTitle n={nMode} hint={M.ui.detail.modeHint}>
            <span id="mode-title">{C.modeTitle}</span>
          </StepTitle>
          <Card>
            <p className="m-0 text-[15px]">{campaign.send_mode === "real" ? C.modeReal : C.modeDry}</p>
            {s.canSend && !archived &&
              (campaign.send_mode === "dry_run" ? (
                s.workspace.role === "owner" ? (
                  realReady ? (
                    <div>
                      <ActionButton action={setSendMode.bind(null, id, "real")} label={C.goReal} variant="ghost" confirm={C.goRealConfirm} />
                    </div>
                  ) : (
                    <p className="m-0 text-[14px] text-[#4a5361]">{C.goRealNeeds}</p>
                  )
                ) : (
                  <p className="m-0 text-[14px] text-[#4a5361]">{C.ownerOnly}</p>
                )
              ) : (
                <div>
                  <ActionButton action={setSendMode.bind(null, id, "dry_run")} label={C.goDry} />
                </div>
              ))}
            <div className="flex flex-col gap-2 border-t border-[#e3e6ec] pt-3">
              <Label>{C.delays}</Label>
              <p className="m-0 text-[15px]">{fill(C.delaysText, { s2: campaign.step2_delay_days, s3: campaign.step3_delay_days })}</p>
              {s.canSend && !hasSequence && <DelaysForm campaignId={id} step2={campaign.step2_delay_days} step3={campaign.step3_delay_days} />}
            </div>
            <div className="flex flex-col gap-2 border-t border-[#e3e6ec] pt-3">
              <Label>{C.mailboxes}</Label>
              {s.canSend && !archived ? (
                <CampaignMailboxesForm key={selected.join(",")} campaignId={id} options={mailboxOptions} selected={selected} />
              ) : (
                <>
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[15px]">
                    {chosen.map((m) => (
                      <li key={m.id} className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="break-all">{m.email}</span>
                        <span className="text-[14px] text-[#4a5361]">
                          {M.mailbox.statuses[m.status]} · {fill(C.sentToday, { n: sentToday[m.email] ?? 0 })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="m-0 text-[14px] text-[#4a5361]">{C.mailboxesHint}</p>
                </>
              )}
              {s.canSend && <FetchRepliesButton mailboxes={chosen.filter((m) => m.status === "ok").map((m) => ({ id: m.id, email: m.email }))} />}
            </div>
          </Card>
        </section>
      </div>

      {s.canSend && <C12Checklist campaignId={id} approvals={c12} isOwner={s.workspace.role === "owner"} clock={clock} userId={s.user.id} envName={REAL_SEND_ENV_NAME} step={nC12} />}

      <section aria-labelledby="pros-title" className="k-step flex min-w-0 flex-col gap-3">
        <StepTitle n={nPros} hint={M.ui.detail.prospectsHint}>
          <span id="pros-title" className="inline-flex items-center gap-2">
            {C.prospects} <CountPill>{prospects.length}</CountPill>
          </span>
        </StepTitle>
        <Paged as="ul" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {prospects.map((p) => {
            const steps = (byProspect.get(p.id) ?? []).filter((m) => m.kind === "sequence").sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
            return (
              <li key={p.id} className="k-row flex min-w-0 flex-col gap-2 rounded-[14px] border border-[#e3e6ec] bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-words text-base font-semibold">{p.company_name}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={p.status === "active" ? "soft" : p.status === "replied" || p.status === "handed_off" ? "blue" : "cold"}>{C.prospectStatus[p.status]}</Badge>
                    {p.stop_reason && p.status === "stopped" && <Badge tone="warn">{C.stopReason[p.stop_reason as keyof typeof C.stopReason] ?? p.stop_reason}</Badge>}
                  </span>
                </div>
                {(p.contact_name || p.contact_title) && <span className="text-[14px] text-[#4a5361]">{[p.contact_name, p.contact_title].filter(Boolean).join(" · ")}</span>}
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[15px]">
                  {p.email ? (
                    <>
                      <span className="break-all">{p.email}</span>
                      {p.email_source === "research" && p.email_source_url ? (
                        <a href={p.email_source_url} target="_blank" rel="noopener noreferrer nofollow" className="k-link text-[14px] underline">
                          {C.sourceResearch} ↗
                        </a>
                      ) : (
                        <span className="text-[14px] text-[#4a5361]">{p.email_confirmed_by === s.user.id ? C.confirmedBy : C.sourceManual}</span>
                      )}
                    </>
                  ) : (
                    <div className="flex min-w-0 flex-col gap-2">
                      <Badge tone="warn">{C.noEmail}</Badge>
                      {p.suggested_email && (
                        <div className="flex min-w-0 flex-col gap-1.5 rounded-[12px] border-2 border-[#f0c48f] bg-warn-soft/60 p-3">
                          <p className="m-0 break-words text-[14px]">{fill(C.suggested, { email: p.suggested_email })}</p>
                          {p.suggested_email_url && (
                            <a href={p.suggested_email_url} target="_blank" rel="noopener noreferrer nofollow" className="k-link break-all text-[14px] underline">
                              {C.suggestedSeen} {p.suggested_email_url} ↗
                            </a>
                          )}
                          {s.canSend && p.status === "active" && (
                            <div>
                              <ActionButton action={confirmSuggestedEmail.bind(null, p.id)} label={C.confirmSuggested} />
                            </div>
                          )}
                        </div>
                      )}
                      {s.canSend && p.status === "active" && <ProspectEmailForm prospectId={p.id} company={p.company_name} />}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {steps.map((m) => (
                    <Badge key={m.id} tone={STATUS_TONE[m.status]}>
                      {m.step}: {M.review.statuses[m.status]}
                    </Badge>
                  ))}
                  {s.canSend && (p.status === "active" || p.status === "skipped") && (
                    <ActionButton action={setProspectSkipped.bind(null, p.id, p.status === "active")} label={p.status === "active" ? C.skip : C.unskip} variant="link" />
                  )}
                </div>
              </li>
            );
          })}
        </Paged>
      </section>
    </div>
  );
}
