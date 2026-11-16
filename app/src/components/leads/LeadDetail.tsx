import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { emailBriefOf, emailChecksOf, getLead, originListsOf } from "@/lib/leads/queries";
import type { EmailQuality } from "@/lib/leads/email-quality";
import { EmailTools } from "@/components/leads/EmailTools";
import { parseCloserBrief } from "@/lib/email/brief";
import { draftBrief } from "@/lib/leads/brief";
import type { Person } from "@/lib/team/types";
import { isSender } from "@/lib/roles";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { HandOffForm } from "@/components/leads/HandOffForm";
import { StatusButtons } from "@/components/leads/StatusButtons";
import { LeadTypePicker } from "@/components/leads/LeadTypePicker";
import { derivedSegmentOf, effectiveTemperature, segmentInputOf } from "@/lib/leads/classify";
import { AddToCallList } from "@/components/leads/AddToCallList";
import { CallHistory } from "@/components/calls/CallHistory";
import { ContactRecord } from "@/components/calls/ContactRecord";
import { leadPhone } from "@/lib/calls/call-input";
import { callsOf } from "@/lib/calls/call-queries";
import { AddToCampaign } from "@/components/leads/AddToCampaign";
import type { CampaignChoice } from "@/lib/leads/campaign-note";
import { displayOf, isStaleProof, originLabel, proofCount } from "@/lib/leads/view";
import { count, date, host, money, UNKNOWN } from "@/components/research/format";
import { Hook, ProofList } from "@/components/research/proof";
import { Pill } from "@/components/research/controls";
import { Notice } from "@/components/email/bits";
import { LevelBadge } from "@/components/qualifier/LevelBadge";
import { LevelNote } from "@/components/qualifier/LevelNote";
import { levelReason, nextStepLabel } from "@/lib/qualifier/view";
import { FieldList } from "@/components/leads/FieldList";
import { WhyHot } from "@/components/leads/WhyHot";
import { whyHotFacts } from "@/lib/leads/why-hot";
import { reserveFor } from "@/lib/ai/gateway";
import { explainDef } from "@/lib/ai/lead-ai-tasks";
import { fill, t } from "@/messages/pt";

const L = t.research.list;
const LB = t.research.labels;
const H = t.handoff;
const CLOSED = ["won", "lost", "discarded"];

// One lead, read-only in F3a. Read as the user, so a closer only opens a lead assigned to her (RLS); anything else is a 404.
export async function LeadDetail({ id, modal = false }: { id: string; modal?: boolean }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  if (!supabase) notFound();
  const detail = await getLead(supabase, id);
  if (!detail) notFound();
  const { lead, candidates, checks, agentName, fields, importNames, queue } = detail;
  const best = candidates.find((c) => c.id === lead.best_candidate_id) ?? candidates[0] ?? null;
  const temp = effectiveTemperature(lead.level, best?.temperature ?? null);
  const display = displayOf(best, fields);
  const importName = lead.origin_import_id ? (importNames[lead.origin_import_id] ?? null) : null;
  const [workspace, user] = await Promise.all([getCurrentWorkspace(), getUser()]);
  const sender = workspace ? isSender(workspace.role) : false;
  const open = !CLOSED.includes(lead.status);
  const mine = Boolean(user && lead.owner_id === user.id);
  const brief = parseCloserBrief(lead.closer_brief);
  // e-mail quality badges (0028): senders only; RLS gives the closer no rows anyway
  // every import/list the lead came from (the closer has no list rows visible, so she gets none)
  const emailQuality: Record<string, EmailQuality> = {};
  const [originMap, mailChecks, calls] = await Promise.all([
    sender ? originListsOf(supabase, [lead.id]) : null,
    sender && workspace ? emailChecksOf(supabase, workspace.id, [...fields.filter((f) => f.field === "email").map((f) => f.value), ...(display.email ? [display.email] : [])]) : null,
    sender ? callsOf(supabase, lead.id) : [],
  ]);
  // the number log_call will use (same rule as SQL lead_phone)
  const phone = leadPhone(best?.phone, fields);
  const origins = originMap?.get(lead.id) ?? [];
  if (mailChecks) for (const [k, v] of mailChecks) emailQuality[k] = v.status;
  const callable = open && !lead.do_not_call && ["new", "call_list"].includes(lead.status) && Boolean(display.phone);

  // Sender-only inputs of the hand-off and the call list (RLS keeps them from the closer anyway).
  let people: Person[] = [];
  let callAgents: { id: string; name: string }[] = [];
  let campaigns: CampaignChoice[] = [];
  let draft: ReturnType<typeof draftBrief> | null = null;
  if (sender && workspace && open) {
    const [peopleRes, agentsRes, callsRes, emailBrief, campaignsRes] = await Promise.all([
      supabase.rpc("list_workspace_people", { p_ws: workspace.id }),
      supabase.from("agents").select("id, name").eq("workspace_id", workspace.id).eq("type", "call").eq("status", "running").is("archived_at", null).order("name"),
      supabase.from("call_logs").select("notes").eq("lead_id", lead.id).eq("outcome", "talked").order("called_at", { ascending: false }).limit(1).maybeSingle(),
      emailBriefOf(supabase, lead.id),
      supabase.from("email_campaigns").select("id, name, status, agent_id, send_mode").eq("workspace_id", workspace.id).neq("status", "archived").order("created_at", { ascending: false }),
    ]);
    const rows = (campaignsRes.data ?? []) as { id: string; name: string; status: string; agent_id: string | null; send_mode: "dry_run" | "real" }[];
    // which of them have an approved sequence: adding a lead there queues step 1 (D6)
    const agentIds = rows.filter((c) => c.agent_id).map((c) => c.id);
    const { data: seqs } = agentIds.length ? await supabase.from("email_sequences").select("campaign_id").eq("status", "approved").in("campaign_id", agentIds) : { data: [] };
    const approvedIds = new Set(((seqs ?? []) as { campaign_id: string }[]).map((r) => r.campaign_id));
    campaigns = rows.map((c) => ({ id: c.id, name: c.name, status: c.status, agentId: c.agent_id, approved: approvedIds.has(c.id), sendMode: c.send_mode }));
    people = (peopleRes.data ?? []) as Person[];
    callAgents = (agentsRes.data ?? []) as { id: string; name: string }[];
    const proofUrls = [
      best?.found_at_url,
      ...checks.filter((k) => k.candidate_id === best?.id && k.result === "ok").flatMap((k) => k.evidence.map((e) => e.url)),
    ].filter((u): u is string => Boolean(u));
    draft = draftBrief({
      company: display.name,
      askForName: best?.ask_for_name ?? null,
      askForTitle: best?.ask_for_title ?? null,
      emailBrief: parseCloserBrief(emailBrief),
      talkedNotes: (callsRes.data as { notes: string } | null)?.notes ?? null,
      proofUrls,
    });
  }
  const now = new Date();
  const stale = candidates.some(
    (c) => isStaleProof(c.found_at_seen_at, now) || checks.some((k) => k.candidate_id === c.id && k.evidence.some((e) => isStaleProof(e.seen_at, now))),
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {!modal && (
        <Link href="/leads" className="font-mono text-xs text-blue underline underline-offset-4">
          ← {t.leads.title}
        </Link>
      )}

      <section className="flex flex-col gap-3.5 border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="lead-modal-title" className="text-[22px]">{display.name}</h2>
          <span className="flex flex-wrap items-center gap-1.5">
            <LevelBadge level={lead.level} />
            {temp && <Pill tone={temp}>{LB.temperature[temp]}</Pill>}
            {best?.second_pass === "refuted" && <Pill tone="no">{L.refuted}</Pill>}
            {!best && <Pill tone="no">{t.leads.unproven}</Pill>}
            {lead.do_not_call && <Pill tone="no">{H.doNotCall}</Pill>}
          </span>
        </div>
        <p className="text-[13px] text-muted">
          {[
            t.leads.statuses[lead.status],
            originLabel({ lead, agentName, importName }),
            fill(t.leads.firstSeen, { date: date(lead.first_seen_at) }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="text-[13px] text-muted">
          <span className="font-semibold text-ink">{t.qualifier.levelLabel} {lead.level}</span> · {levelReason(fields, lead.level)}
          {queue && <> · {nextStepLabel(queue.next_step, queue.done_reason)}</>}
        </p>
        {sender && (
          <p className="text-[13px] text-muted">
            <span className="font-semibold text-ink">{t.leads.origin.cameFrom}</span>{" "}
            {origins.length > 0 ? origins.map((o) => fill(t.leads.origin.item, { name: o.name, date: date(o.at) })).join(", ") : t.leads.origin.none}
          </p>
        )}
        {sender && (
          <div className="flex flex-wrap items-end gap-4">
            <LeadTypePicker leadId={lead.id} value={lead.segment} derived={derivedSegmentOf(segmentInputOf(lead, best, display.companyType ?? null, origins))} />
          </div>
        )}
        {queue && lead.level_note && <LevelNote leadId={lead.id} note={lead.level_note} />}

        {best && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs text-muted">{L.askFor}</span>
                <span className="text-[15px] font-semibold">
                  {best.ask_for_name ? `${best.ask_for_name}${best.ask_for_title ? ` · ${best.ask_for_title}` : ""}` : UNKNOWN}
                </span>
                {best.name_confidence && (
                  <span className="text-[13px] text-muted">
                    {L.confidence} {LB.confidence[best.name_confidence]}
                  </span>
                )}
                {best.name_source_url && (
                  <a href={best.name_source_url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-blue underline underline-offset-2">
                    {host(best.name_source_url)}
                  </a>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-xs text-muted">{L.contact}</span>
                <span className="text-[15px] font-semibold">
                  {best.phone ?? UNKNOWN}
                  {best.phone && !best.phone_source_url && <span className="ml-1.5 text-[13px] font-normal text-muted">{L.unverified}</span>}
                </span>
                {best.phone_source_url && (
                  <a href={best.phone_source_url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-blue underline underline-offset-2">
                    {host(best.phone_source_url)}
                  </a>
                )}
              </div>
            </div>

            <dl className="m-0 grid grid-cols-3 gap-2 border-y border-line py-2.5">
              {[
                [L.permits, count(best.permit_count)],
                [L.totalValue, money(best.total_value_usd)],
                [L.lastPermit, date(best.last_permit_date)],
              ].map(([k, v]) => (
                <div key={k} className="flex min-w-0 flex-col">
                  <dt className="font-mono text-xs text-muted">{k}</dt>
                  <dd className="m-0 font-display text-xl font-bold sm:text-2xl">{v}</dd>
                </div>
              ))}
            </dl>

            {best.biggest_job_address && (
              <p className="text-sm">
                <span className="font-semibold">{L.biggestJob}</span> {best.biggest_job_address} · {money(best.biggest_job_value_usd)}
              </p>
            )}
            {best.hook && <Hook text={best.hook} />}
            {(best.name_note || best.notes) && (
              <p className="text-[13px] text-muted">
                <span className="font-semibold text-ink">{L.note}</span> {[best.name_note, best.notes].filter(Boolean).join(" ")}
              </p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="research-title" className="flex flex-col gap-2 border border-line bg-surface p-4">
        <h2 id="research-title" className="text-xl">
          {t.leads.research.title}
        </h2>
        <dl className="m-0 grid grid-cols-3 gap-2">
          {[
            [t.leads.research.temperature, temp ? LB.temperature[temp] : t.leads.research.none],
            [t.leads.research.approach, best?.approach ? LB.approach[best.approach] : t.leads.research.none],
            [t.leads.research.proof, best ? fill(t.leads.proofCount, { n: proofCount(checks.filter((k) => k.candidate_id === best.id)) }) : t.leads.unproven],
          ].map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-col">
              <dt className="font-mono text-xs text-muted">{k}</dt>
              <dd className="m-0 text-[15px] font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <WhyHot leadId={lead.id} facts={whyHotFacts({ level: lead.level, best, fields, checks })} canSummarize={sender} reserveUsd={reserveFor(explainDef)} />

      {brief && (
        <section aria-labelledby="brief-title" className="flex flex-col gap-2 border border-ink bg-surface p-4">
          <h2 id="brief-title" className="text-xl">
            {H.brief}
          </h2>
          <p className="m-0 text-sm"><span className="font-mono text-xs">{H.who}</span> {brief.who}</p>
          <p className="m-0 text-sm"><span className="font-mono text-xs">{H.said}</span> {brief.what_they_said}</p>
          <p className="m-0 border-l-2 border-blue pl-3 text-sm font-semibold">{brief.next_step}</p>
          {brief.evidence_urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[13px] text-blue underline underline-offset-4">
              {u} ↗
            </a>
          ))}
        </section>
      )}

      {sender && phone && (
        <section aria-labelledby="contact-title" className="flex flex-col gap-3 border border-line bg-surface p-4">
          <h2 id="contact-title" className="text-xl">
            {t.calls.record.title}
          </h2>
          <ContactRecord leadId={lead.id} afterSave="stay" canRecord={open && !lead.do_not_call} />
        </section>
      )}
      {sender && calls.length > 0 && <CallHistory calls={calls} />}

      {open && (sender || mine) && (
        <section aria-labelledby="actions-title" className="flex flex-col gap-4 border border-line bg-surface p-4">
          <h2 id="actions-title" className="sr-only">
            {H.button}
          </h2>
          {sender && draft && <HandOffForm leadId={lead.id} closers={people} draft={draft} />}
          {sender && callable && <AddToCallList leadId={lead.id} agents={callAgents} />}
          {sender && !lead.do_not_call && <AddToCampaign leadIds={[lead.id]} campaigns={campaigns} />}
          {sender && <EmailTools selected={[lead.id]} single />}
          {mine && !sender && !lead.do_not_call && display.phone && (
            <Link href={`/leads/ligar/${lead.id}`} className="inline-flex min-h-11 w-fit items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash">
              {H.callNow}
            </Link>
          )}
          <StatusButtons leadId={lead.id} />
        </section>
      )}

      {fields.length > 0 && (
        <section aria-labelledby="fields-title" className="flex flex-col gap-3">
          <h2 id="fields-title" className="text-2xl">
            {t.leads.fieldsTitle}
          </h2>
          <FieldList fields={fields} importNames={importNames} emailQuality={emailQuality} />
        </section>
      )}

      {candidates.length > 0 && (
        <section aria-labelledby="proof-title" className="flex flex-col gap-3">
          <h2 id="proof-title" className="text-2xl">
            {t.leads.proofTitle}
          </h2>
          <p className="text-[13px] text-muted">{fill(t.leads.seenIn, { n: candidates.length })}</p>
          {stale && <Notice tone="warn">{t.leads.staleHint}</Notice>}
          {candidates.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 border border-line bg-surface p-4">
              <span className="font-mono text-xs text-muted">
                {c.run_title || UNKNOWN} · {date(c.run_created_at)}
              </span>
              <ProofList c={c} checks={checks.filter((k) => k.candidate_id === c.id)} now={now} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
