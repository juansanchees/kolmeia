import type { CandidateRow } from "@/lib/research/rows";
import type { LeadDetail } from "@/lib/leads/types";
import { sanitizeUrl } from "@/lib/safe-url";
import { telHref } from "@/lib/calls/view";
import { effectiveTemperature } from "@/lib/leads/classify";
import { displayOf, isStaleProof } from "@/lib/leads/view";
import { parseCloserBrief } from "@/lib/email/brief";
import { Badge, HexPanel, Icon, Notice } from "@/components/ui";
import { LevelBadge } from "@/components/qualifier/LevelBadge";
import { Pill } from "@/components/research/controls";
import { date, host, UNKNOWN } from "@/components/research/format";
import { getT } from "@/lib/i18n/server";

const PHONE =
  "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z";

type Proof = { url: string; title: string; excerpt: string | null; seenAt: string | null };

/** Up to 4 distinct proof URLs: where the company was found, then the evidence of the checks. */
function proofs(candidates: LeadDetail["candidates"], checks: LeadDetail["checks"]): Proof[] {
  const out: Proof[] = [];
  const add = (p: Proof) => {
    const url = sanitizeUrl(p.url);
    if (url && !out.some((o) => o.url === url)) out.push({ ...p, url });
  };
  for (const c of candidates) if (c.found_at_url) add({ url: c.found_at_url, title: c.found_at_title ?? "", excerpt: c.found_at_excerpt ?? null, seenAt: c.found_at_seen_at ?? null });
  for (const k of checks) for (const e of k.evidence) add({ url: e.url, title: e.title ?? "", excerpt: e.excerpt ?? null, seenAt: e.seen_at ?? null });
  return out.slice(0, 4);
}

/** What the caller needs before dialing: the number (tel: link and plain text), who to ask for, the hook, the proof. */
export async function CallFacts({ detail, phone, now, blocked = false }: { detail: LeadDetail; phone: string | null; now: Date; blocked?: boolean }) {
  const t = await getT();
  const C = t.calls;
  const LB = t.research.labels;
  const { lead, candidates, checks, fields } = detail;
  const best: CandidateRow | null = candidates.find((c) => c.id === lead.best_candidate_id) ?? candidates[0] ?? null;
  const display = displayOf(best, fields);
  const temp = effectiveTemperature(lead.level, best?.temperature ?? null);
  const href = !blocked && phone ? telHref(phone) : null;
  const brief = parseCloserBrief(lead.closer_brief);
  return (
    <HexPanel as="section" aria-labelledby="call-lead-title" c={22} cSm={12} raised className="flex flex-col gap-5 py-7" wrapClassName="k-in [animation-delay:.08s]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="call-lead-title" className="min-w-0 break-words text-[30px] md:text-[36px]">{display.name}</h2>
        <span className="flex flex-wrap items-center gap-2">
          <LevelBadge level={lead.level} />
          {temp && <Pill tone={temp}>{LB.temperature[temp]}</Pill>}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {href ? (
          <a href={href} className="k-lift inline-flex text-ink no-underline drop-shadow-[0_8px_12px_rgba(15,27,61,0.22)]">
            <span className="hx inline-flex min-h-16 items-center justify-center gap-3 bg-honey px-10 font-display text-[28px] font-bold uppercase tracking-wide [--c:16px]">
              <Icon d={PHONE} size={26} />
              {C.call}
            </span>
          </a>
        ) : (
          <Notice tone="warn">{blocked ? C.blockedShort : C.noPhone}</Notice>
        )}
        {phone && (
          <p className="m-0 text-base text-[#4a5361]">
            {C.rawPhone}: <span className="font-mono text-xl font-semibold text-ink">{phone}</span>
          </p>
        )}
      </div>

      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5 rounded-[14px] bg-ground px-4 py-3">
          <dt className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{C.askFor}</dt>
          <dd className="m-0 text-lg font-semibold">
            {best?.ask_for_name ? `${best.ask_for_name}${best.ask_for_title ? ` · ${best.ask_for_title}` : ""}` : UNKNOWN}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 rounded-[14px] bg-ground px-4 py-3">
          <dt className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{C.city}</dt>
          <dd className="m-0 text-lg font-semibold">{display.city ?? UNKNOWN}</dd>
        </div>
      </dl>

      {best?.hook && (
        <p className="m-0 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3 text-lg leading-normal">
          <span className="block font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{C.hook}</span>
          <q lang="en" className="[quotes:none]">{best.hook}</q>
        </p>
      )}

      {brief && (
        <div className="flex flex-col gap-1 border-t border-[#e3e6ec] pt-4 text-base">
          <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{C.brief}</span>
          <p className="m-0">{brief.who}</p>
          {brief.what_they_said && <p className="m-0">{brief.what_they_said}</p>}
          {brief.next_step && <p className="m-0 border-l-4 border-honey pl-3 font-semibold">{brief.next_step}</p>}
        </div>
      )}

      {proofs(candidates, checks).length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[#e3e6ec] pt-4">
          <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{C.proofTitle}</span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {proofs(candidates, checks).map((p) => (
              <li key={p.url} className="text-[15px]">
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="k-link font-medium underline">
                  {p.title || host(p.url)}
                </a>
                {p.seenAt && <span className="text-[#4a5361]"> · {t.research.list.seenOn} {date(p.seenAt, t.intl)}</span>}
                {isStaleProof(p.seenAt, now) && <Badge tone="warn" className="ml-2 py-0! text-[13px]!">{C.stale}</Badge>}
                {p.excerpt && <span className="block italic text-[#4a5361]">“{p.excerpt}”</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="m-0 flex list-none flex-col gap-1 border-t border-[#e3e6ec] p-0 pt-4 text-[15px] text-[#4a5361]">
        <li>{C.b2bOnly}</li>
        <li>{C.noRecording}</li>
      </ul>
    </HexPanel>
  );
}
