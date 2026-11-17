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
    <div className="flex flex-col gap-3">
      <Link href={`/campanhas/${id}`} className="text-sm text-blue underline underline-offset-4">
        ← {campaign.name}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-3xl">{R.title}</h2>
        <div className="flex border border-ink" role="group" aria-label={R.title}>
          <Link href={`/campanhas/${id}/revisar`} aria-current={!listMode ? "page" : undefined} className={`inline-flex min-h-11 items-center px-4 text-sm no-underline ${!listMode ? "bg-ink font-semibold text-white" : "bg-surface text-ink"}`}>
            {R.oneByOne}
          </Link>
          <Link href={`/campanhas/${id}/revisar?modo=lista`} aria-current={listMode ? "page" : undefined} className={`inline-flex min-h-11 items-center px-4 text-sm no-underline ${listMode ? "bg-ink font-semibold text-white" : "bg-surface text-ink"}`}>
            {R.listMode}
          </Link>
        </div>
      </div>
    </div>
  );

  if (!prospects.length) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <p className="text-sm">{R.nothing}</p>
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
    <div className="flex min-w-0 flex-col gap-5">
      {header}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted">{fill(R.of, { i: i + 1, n })}</span>
        <div className="flex gap-2">
          {i > 0 && (
            <Link href={`/campanhas/${id}/revisar?i=${i - 1}`} className="inline-flex min-h-11 items-center border border-edge bg-surface px-4 text-sm text-ink no-underline hover:border-ink">
              {R.prev}
            </Link>
          )}
          {i < n - 1 && (
            <Link href={`/campanhas/${id}/revisar?i=${i + 1}`} className="inline-flex min-h-11 items-center border border-edge bg-surface px-4 text-sm text-ink no-underline hover:border-ink">
              {R.next}
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <Card aria-labelledby="who" className="flex-[1_1_280px]">
          <h3 id="who" className="m-0 break-words font-display text-2xl uppercase">
            {p.company_name}
          </h3>
          <div className="text-sm">
            {[p.contact_name, p.contact_title].filter(Boolean).join(" · ")}
            {p.email && <div className="break-all text-muted">{p.email}</div>}
          </div>
          <div className="flex flex-col gap-2">
            <Label>{R.facts}</Label>
            {p.hook && <p className="border border-blue-soft bg-blue-wash p-3 text-sm">“{p.hook}”</p>}
            {p.evidence.length === 0 ? (
              <p className="text-sm text-muted">{R.noFacts}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {p.evidence.map((e, k) => (
                  <li key={`${e.url}-${k}`} className="text-[13px]">
                    <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="break-words text-blue underline underline-offset-4">
                      {e.title || e.url} ↗
                    </a>
                    {e.excerpt && <span className="block text-muted">“{e.excerpt}”</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {aiStep && (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <span className="flex flex-wrap items-center gap-2">
                <Label>{R.factsUsed}</Label>
                <Badge tone="soft">{t.ai.suggestion}</Badge>
              </span>
              {facts.length > 0 && !aiStep.ai_no_fact ? (
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
                  {facts.map((f, k) => (
                    <li key={`${k}-${f}`} className="break-words">
                      {f}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-sm text-warn">{R.noFact}</p>
              )}
              {aiStep.ai_signal && (
                <p className="m-0 text-sm">
                  <span className="font-semibold">{R.signal}</span> {aiStep.ai_signal}
                </p>
              )}
              {aiStep.ai_model && (
                <p className="m-0 font-mono text-xs text-muted">{fill(R.model, { model: aiStep.ai_model === MODELS.sonnet ? R.modelStrong : R.modelCheap })}</p>
              )}
            </div>
          )}
          {checks.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <Label>{C.title}</Label>
              {checks.map(({ step, list }) => (
                <ul key={step} aria-label={fill(C.step, { n: step })} className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                  <li className="font-mono text-xs text-muted">{fill(C.step, { n: step })}</li>
                  {list.filter((c) => step === 1 || !c.ok).map((c) => (
                    <li key={c.kind} className={c.ok ? "" : "text-warn"}>
                      <span className="font-semibold">{c.ok ? C.ok : C.warn}</span> {c.text}
                    </li>
                  ))}
                </ul>
              ))}
              <p className="m-0 text-[13px] text-muted">{C.ok} {C.footer}</p>
            </div>
          )}
          {s.canSend && (
            <div className="flex flex-wrap gap-2">
              <ApproveAllButton items={pending} />
              {pending.length > 0 && (
                <ActionButton
                  action={redraftStrongAction.bind(null, p.id)}
                  label={fill(R.strong, { strong: usd(reserveFor(draftStrongDef), t.intl), cheap: usd(reserveFor(draftDef), t.intl) })}
                />
              )}
              {p.status === "active" && <ActionButton action={setProspectSkipped.bind(null, p.id, true)} label={R.skipCompany} />}
            </div>
          )}
        </Card>

        <div className="flex min-w-0 flex-[2_1_420px] flex-col gap-4">
          {editable.map((m) => (
            <MessageEditor key={`${m.id}-${m.updatedAt}`} m={m} canSend={s.canSend} />
          ))}
        </div>
      </div>
    </div>
  );
}
