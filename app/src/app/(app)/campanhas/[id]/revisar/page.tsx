import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMailboxes, loadSender, previewMessage } from "@/lib/email/queries";
import { emailSession, previewOrigin } from "@/lib/email/session";
import { CAMPAIGN_COLUMNS, MESSAGE_COLUMNS, PROSPECT_COLUMNS, type CampaignRow, type MessageRow, type ProspectRow } from "@/lib/email/types";
import { redraftStrongAction, setProspectSkipped } from "../../actions";
import { reserveFor } from "@/lib/ai/gateway";
import { draftDef, draftStrongDef } from "@/lib/ai/email-tasks";
import { MODELS } from "@/lib/ai/models";
import { emailChecksOf } from "@/lib/leads/queries";
import { contentChecks } from "@/lib/email/warnings";
import { usd } from "@/components/research/format";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, Card, Label } from "@/components/email/bits";
import { buttonClass, CountPill, EmptyState, segItemCls, segWrapCls, StepTitle } from "@/components/ui";
import { isPast, when } from "@/components/email/format";
import { ApproveAllButton, MessageEditor, ReviewList, type EditableMessage, type ReviewRow } from "@/components/email/MessageEditor";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

/** Review screen: one prospect at a time (default) or a list where reviewed prospects are approved together. */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const t = await getT();
  const M = t.email;
  const R = M.review;
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await emailSession();
  if (!s) notFound();
  const { data: c } = await s.supabase.from("email_campaigns").select(CAMPAIGN_COLUMNS).eq("id", id).maybeSingle();
  if (!c) notFound();
  const campaign = c as CampaignRow;
  const [pRes, mRes, sender, mailboxes, origin] = await Promise.all([
    s.supabase.from("email_prospects").select(PROSPECT_COLUMNS).eq("campaign_id", id).in("status", ["active", "replied", "handed_off"]).order("created_at", { ascending: true }),
    s.supabase.from("email_messages").select(MESSAGE_COLUMNS).eq("campaign_id", id).eq("kind", "sequence").order("step", { ascending: true }),
    loadSender(s.supabase, campaign.workspace_id),
    loadMailboxes(s.supabase, campaign.workspace_id),
    previewOrigin(),
  ]);
  const messages = (mRes.data ?? []) as MessageRow[];
  const prospects = ((pRes.data ?? []) as ProspectRow[]).filter((p) => messages.some((m) => m.prospect_id === p.id && ["draft", "approved", "rejected"].includes(m.status)));
  const fromAddress = mailboxes.find((m) => m.id === campaign.mailbox_id)?.email ?? null;
  const listMode = sp.modo === "lista";

  const header = (
    <div className="k-in flex flex-col gap-3">
      <Link href={`/campanhas/${id}`} className="k-link self-start text-[15px] underline">
        ← {campaign.name}
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-3xl">{R.title}</h2>
          <p className="m-0 text-base text-[#4a5361]">{M.ui.review.subtitle}</p>
        </div>
        <nav className={segWrapCls} aria-label={R.title}>
          <Link href={`/campanhas/${id}/revisar`} aria-current={!listMode ? "page" : undefined} className={segItemCls(!listMode)}>
            {R.oneByOne}
          </Link>
          <Link href={`/campanhas/${id}/revisar?modo=lista`} aria-current={listMode ? "page" : undefined} className={segItemCls(listMode)}>
            {R.listMode}
          </Link>
        </nav>
      </div>
    </div>
  );

  if (!prospects.length) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <EmptyState title={R.nothing}>{M.ui.review.nothingNext}</EmptyState>
      </div>
    );
  }

  if (listMode) {
    const rows: ReviewRow[] = prospects.slice(0, 50).map((p) => {
      const ms = messages.filter((m) => m.prospect_id === p.id);
      return {
        prospectId: p.id,
        company: p.company_name,
        contact: [p.contact_name, p.email].filter(Boolean).join(" · "),
        messages: ms
          .filter((m) => m.status === "draft" || m.status === "approved" || m.status === "rejected")
          .map((m) => ({ id: m.id, updatedAt: m.updated_at, step: m.step ?? 1, subject: m.subject, body: m.body, status: m.status })),
      };
    });
    return (
      <div className="flex flex-col gap-5">
        {header}
        <p className="m-0 text-base text-[#4a5361]">{M.ui.review.listHint}</p>
        {s.canSend ? <ReviewList rows={rows} campaignId={id} /> : null}
      </div>
    );
  }

  const n = prospects.length;
  const raw = Number(Array.isArray(sp.i) ? sp.i[0] : (sp.i ?? 0));
  // ?p=<prospect id> (links from the E-mail overview) wins over ?i=<position>
  const byId = typeof sp.p === "string" ? prospects.findIndex((x) => x.id === sp.p) : -1;
  const i = byId >= 0 ? byId : Number.isInteger(raw) && raw >= 0 && raw < n ? raw : 0;
  const p = prospects[i];
  const ms = messages.filter((m) => m.prospect_id === p.id);
  const editable: EditableMessage[] = ms.map((m) => {
    const pv = previewMessage(m, p, sender, fromAddress, origin);
    const dueText =
      m.status === "sent" || m.status === "dry_run"
        ? when(m.sent_at, t.intl)
        : m.due_at
          ? isPast(m.due_at)
            ? R.dueNow
            : fill(R.due, { when: when(m.due_at, t.intl) })
          : fill(R.dueAfter, { n: m.step === 2 ? campaign.step2_delay_days : campaign.step3_delay_days });
    return {
      id: m.id,
      updatedAt: m.updated_at,
      toAddress: m.approved_to ?? m.to_address ?? p.email,
      kind: m.kind,
      step: m.step,
      subject: m.subject,
      body: m.body,
      status: m.status,
      ai_drafted: m.ai_drafted,
      human_edited: m.human_edited,
      dueText,
      preview: pv.preview,
      previewProblem: pv.problem,
    };
  });
  const pending = ms.filter((m) => m.status === "draft" || m.status === "rejected").map((m) => ({ id: m.id, updatedAt: m.updated_at }));
  const aiStep = ms.find((m) => m.ai_drafted) ?? null;
  const facts = Array.isArray(aiStep?.ai_facts) ? aiStep.ai_facts.filter((f): f is string => typeof f === "string") : [];
  // item 11: local checks before approval, the recipient's quality from 0028 email_checks (no row = never checked)
  const recipient = p.email ? ((await emailChecksOf(s.supabase, campaign.workspace_id, [p.email])).get(p.email.trim().toLowerCase())?.status ?? null) : null;
  const toCheck = ms.filter((m) => m.kind === "sequence" && (m.status === "draft" || m.status === "rejected"));
  const checks = toCheck.map((m) => ({ step: m.step ?? 1, list: contentChecks({ subject: m.subject, body: m.body, step: m.step, recipient: m.step === 1 ? recipient : undefined }, t) }));
  const C = M.checks;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {header}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CountPill tone="navy" className="text-[15px]">{fill(R.of, { i: i + 1, n })}</CountPill>
        <div className="flex gap-2">
          {i > 0 && (
            <Link href={`/campanhas/${id}/revisar?i=${i - 1}`} className={buttonClass("secondary", "sm")}>
              {R.prev}
            </Link>
          )}
          {i < n - 1 && (
            <Link href={`/campanhas/${id}/revisar?i=${i + 1}`} className={buttonClass("secondary", "sm")}>
              {R.next}
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <section aria-labelledby="who" className="k-step flex min-w-0 flex-[1_1_280px] flex-col gap-3">
          <StepTitle n={1} hint={M.ui.review.factsHint}>
            {R.facts}
          </StepTitle>
          <Card>
            <h3 id="who" className="m-0 break-words font-display text-2xl uppercase">
              {p.company_name}
            </h3>
            <div className="text-[15px]">
              {[p.contact_name, p.contact_title].filter(Boolean).join(" · ")}
              {p.email && <div className="break-all font-mono text-[14px] text-[#4a5361]">{p.email}</div>}
            </div>
            <div className="flex flex-col gap-2">
              {p.hook && <p className="m-0 rounded-[12px] border-2 border-honey-edge bg-honey-soft p-3 text-[15px]">“{p.hook}”</p>}
              {p.evidence.length === 0 ? (
                <p className="m-0 text-[15px] text-[#4a5361]">{R.noFacts}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {p.evidence.map((e, k) => (
                    <li key={`${e.url}-${k}`} className="text-[14px]">
                      <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="k-link break-words underline">
                        {e.title || e.url} ↗
                      </a>
                      {e.excerpt && <span className="block text-[#4a5361]">“{e.excerpt}”</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {aiStep && (
              <div className="flex flex-col gap-2 border-t border-[#e3e6ec] pt-3">
                <span className="flex flex-wrap items-center gap-2">
                  <Label>{R.factsUsed}</Label>
                  <Badge tone="soft">{t.ai.suggestion}</Badge>
                </span>
                {facts.length > 0 && !aiStep.ai_no_fact ? (
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[15px]">
                    {facts.map((f, k) => (
                      <li key={`${k}-${f}`} className="break-words">
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="m-0 text-[15px] text-warn">{R.noFact}</p>
                )}
                {aiStep.ai_signal && (
                  <p className="m-0 text-[15px]">
                    <span className="font-semibold">{R.signal}</span> {aiStep.ai_signal}
                  </p>
                )}
                {aiStep.ai_model && (
                  <p className="m-0 font-mono text-[13px] text-[#4a5361]">{fill(R.model, { model: aiStep.ai_model === MODELS.sonnet ? R.modelStrong : R.modelCheap })}</p>
                )}
              </div>
            )}
            {checks.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-[#e3e6ec] pt-3">
                <Label>{C.title}</Label>
                {checks.map(({ step, list }) => (
                  <ul key={step} aria-label={fill(C.step, { n: step })} className="m-0 flex list-none flex-col gap-1.5 p-0 text-[14px]">
                    <li className="font-mono text-[13px] text-[#4a5361]">{fill(C.step, { n: step })}</li>
                    {list.filter((c) => step === 1 || !c.ok).map((c) => (
                      <li key={c.kind} className="flex items-start gap-2">
                        <Badge tone={c.ok ? "ok" : "warn"}>{c.ok ? C.ok : C.warn}</Badge>
                        <span className={c.ok ? "" : "text-warn"}>{c.text}</span>
                      </li>
                    ))}
                  </ul>
                ))}
                <p className="m-0 text-[14px] text-[#4a5361]">{C.ok} {C.footer}</p>
              </div>
            )}
          </Card>
        </section>

        <section aria-labelledby="emails-title" className="k-step flex min-w-0 flex-[2_1_420px] flex-col gap-3">
          <StepTitle n={2} hint={M.ui.review.emailsHint}>
            <span id="emails-title">{M.ui.review.emails}</span>
          </StepTitle>
          {editable.map((m) => (
            <MessageEditor key={`${m.id}-${m.updatedAt}`} m={m} canSend={s.canSend} />
          ))}
        </section>
      </div>

      {s.canSend && (
        <section aria-labelledby="finish-title" className="k-step flex min-w-0 flex-col gap-3">
          <StepTitle n={3} hint={M.ui.review.finishHint}>
            <span id="finish-title">{M.ui.review.finish}</span>
          </StepTitle>
          <div className="flex flex-wrap items-start gap-3">
            <ApproveAllButton items={pending} />
            {pending.length > 0 && (
              <ActionButton
                action={redraftStrongAction.bind(null, p.id)}
                label={fill(R.strong, { strong: usd(reserveFor(draftStrongDef), t.intl), cheap: usd(reserveFor(draftDef), t.intl) })}
              />
            )}
            {p.status === "active" && <ActionButton action={setProspectSkipped.bind(null, p.id, true)} label={R.skipCompany} />}
          </div>
        </section>
      )}
    </div>
  );
}
