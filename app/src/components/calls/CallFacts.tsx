import type { CandidateRow } from "@/lib/research/rows";
import type { LeadDetail } from "@/lib/leads/types";
import { telHref } from "@/lib/calls/view";
import { displayOf, isStaleProof } from "@/lib/leads/view";
import { parseCloserBrief } from "@/lib/email/brief";
import { Notice } from "@/components/email/bits";
import { LevelBadge } from "@/components/qualifier/LevelBadge";
import { Pill } from "@/components/research/controls";
import { date, host, UNKNOWN } from "@/components/research/format";
import { t } from "@/messages/pt";

const C = t.calls;
const LB = t.research.labels;

type Proof = { url: string; title: string; excerpt: string | null; seenAt: string | null };

/** Up to 4 distinct proof URLs: where the company was found, then the evidence of the checks. */
function proofs(candidates: LeadDetail["candidates"], checks: LeadDetail["checks"]): Proof[] {
  const out: Proof[] = [];
  const add = (p: Proof) => {
    if (p.url && !out.some((o) => o.url === p.url)) out.push(p);
  };
  for (const c of candidates) if (c.found_at_url) add({ url: c.found_at_url, title: c.found_at_title ?? "", excerpt: c.found_at_excerpt ?? null, seenAt: c.found_at_seen_at ?? null });
  for (const k of checks) for (const e of k.evidence) add({ url: e.url, title: e.title ?? "", excerpt: e.excerpt ?? null, seenAt: e.seen_at ?? null });
  return out.slice(0, 4);
}

/** What the caller needs before dialing: the number (tel: link and plain text), who to ask for, the hook, the proof. */
export function CallFacts({ detail, phone, now }: { detail: LeadDetail; phone: string | null; now: Date }) {
  const { lead, candidates, checks, fields } = detail;
  const best: CandidateRow | null = candidates.find((c) => c.id === lead.best_candidate_id) ?? candidates[0] ?? null;
  const display = displayOf(best, fields);
  const href = phone ? telHref(phone) : null;
  const brief = parseCloserBrief(lead.closer_brief);
  return (
    <section className="flex flex-col gap-3.5 border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[22px]">{display.name}</h2>
        <span className="flex flex-wrap items-center gap-1.5">
          <LevelBadge level={lead.level} />
          {best?.temperature && <Pill tone={best.temperature}>{LB.temperature[best.temperature]}</Pill>}
        </span>
      </div>

      {href ? (
        <a href={href} className="inline-flex min-h-14 items-center justify-center border border-blue bg-blue px-5 font-display text-2xl font-bold text-white hover:bg-ink">
          {C.call}
        </a>
      ) : (
        <Notice tone="warn">{C.noPhone}</Notice>
      )}
      {phone && (
        <p className="text-[13px] text-muted">
          {C.rawPhone}: <span className="font-mono font-semibold text-ink">{phone}</span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-muted">{C.askFor}</span>
          <span className="text-[15px] font-semibold">
            {best?.ask_for_name ? `${best.ask_for_name}${best.ask_for_title ? ` · ${best.ask_for_title}` : ""}` : UNKNOWN}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-muted">{C.city}</span>
          <span className="text-[15px] font-semibold">{display.city ?? UNKNOWN}</span>
        </div>
      </div>

      {best?.hook && (
        <p className="bg-blue-soft p-3 text-base leading-normal">
          <span className="block font-mono text-xs text-blue-ink">{C.hook}</span>
          <q lang="en" className="[quotes:none]">{best.hook}</q>
        </p>
      )}

      {brief && (
        <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px]">
          <span className="font-mono text-xs text-muted">{C.brief}</span>
          <p>{brief.who}</p>
          {brief.what_they_said && <p>{brief.what_they_said}</p>}
          {brief.next_step && <p className="font-semibold">{brief.next_step}</p>}
        </div>
      )}

      {proofs(candidates, checks).length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <span className="font-mono text-xs text-muted">{C.proofTitle}</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {proofs(candidates, checks).map((p) => (
              <li key={p.url} className="text-[13px]">
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                  {p.title || host(p.url)}
                </a>
                {p.seenAt && <span className="text-muted"> · {t.research.list.seenOn} {date(p.seenAt)}</span>}
                {isStaleProof(p.seenAt, now) && <span className="ml-1.5 border border-line px-1 font-mono text-[11px] text-muted">{C.stale}</span>}
                {p.excerpt && <span className="block italic text-muted">“{p.excerpt}”</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Notice tone="info">{C.b2bOnly}</Notice>
        <Notice tone="info">{C.noRecording}</Notice>
      </div>
    </section>
  );
}
