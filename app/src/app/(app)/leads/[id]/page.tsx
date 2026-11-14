import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getLead } from "@/lib/leads/queries";
import { isStaleProof, originLabel } from "@/lib/leads/view";
import { count, date, host, money, UNKNOWN } from "@/components/research/format";
import { Hook, ProofList } from "@/components/research/proof";
import { Pill } from "@/components/research/controls";
import { Notice } from "@/components/email/bits";
import { fill, t } from "@/messages/pt";

const L = t.research.list;
const LB = t.research.labels;

// One lead, read-only in F3a. Read as the user, so a closer only opens a lead assigned to her (RLS); anything else is a 404.
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  if (!supabase) notFound();
  const detail = await getLead(supabase, id);
  if (!detail) notFound();
  const { lead, candidates, checks, agentName } = detail;
  const best = candidates.find((c) => c.id === lead.best_candidate_id) ?? candidates[0];
  if (!best) notFound();
  const now = new Date();
  const stale = candidates.some(
    (c) => isStaleProof(c.found_at_seen_at, now) || checks.some((k) => k.candidate_id === c.id && k.evidence.some((e) => isStaleProof(e.seen_at, now))),
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Link href="/leads" className="font-mono text-xs text-blue underline underline-offset-4">
        ← {t.leads.title}
      </Link>

      <section className="flex flex-col gap-3.5 border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[22px]">{best.name}</h2>
          <span className="flex flex-wrap gap-1.5">
            {best.temperature && <Pill tone={best.temperature}>{LB.temperature[best.temperature]}</Pill>}
            {best.second_pass === "refuted" && <Pill tone="no">{L.refuted}</Pill>}
          </span>
        </div>
        <p className="text-[13px] text-muted">
          {[
            best.approach ? LB.approach[best.approach] : null,
            t.leads.statuses[lead.status],
            originLabel({ lead, agentName }),
            fill(t.leads.firstSeen, { date: date(lead.first_seen_at) }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

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
      </section>

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
    </div>
  );
}
