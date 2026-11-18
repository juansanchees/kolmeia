import { Badge, CountPill, HexPanel } from "@/components/ui";
import { AiBubble, UserBubble } from "@/components/research/controls";
import { date } from "@/components/research/format";
import type { RoundSummary } from "@/lib/hunt/rounds";
import { word } from "@/lib/hunt/text";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { OUTCOME_TONE } from "./SourceCoverage";

export type ThreadMessage = { id: string; role: "user" | "agent"; body: string; created_at: string };
export type ThreadRound = { id: string; n: number; ended_at: string | null; stop_reason: string | null; summary: RoundSummary | null };

const small = "font-mono text-[13px] uppercase tracking-wide text-[#4a5361]";

async function RoundCard({ r }: { r: ThreadRound }) {
  const t = await getT();
  const R = t.hunt.round;
  const s = r.summary;
  return (
    <HexPanel as="section" aria-label={fill(t.hunt.campaign.round, { n: r.n })} tone="honey" c={16} cSm={8} className="flex flex-col gap-3 py-5" data-testid={`round-${r.n}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 font-body text-lg font-semibold normal-case tracking-normal">{fill(t.hunt.campaign.round, { n: r.n })}</h3>
        {r.ended_at ? <span className="font-mono text-sm text-[#4a5361]">{date(r.ended_at, t.intl)}</span> : <Badge tone="neutral">{t.hunt.campaign.running}</Badge>}
      </div>
      {s && (
        <>
          <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2">
            {([[R.new, s.new], [R.updated, s.updated], [R.demoted, s.demoted]] as const).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2"><dt className="text-base">{k}</dt><dd className="m-0"><CountPill>{v}</CountPill></dd></div>
            ))}
          </dl>
          <div className="flex flex-col gap-1">
            <span className={small}>{R.sources}</span>
            {s.sources.length === 0 ? <p className="m-0 text-base text-[#4a5361]">{R.noSources}</p> : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {s.sources.map((x) => (
                  <li key={`${x.town}|${x.source}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
                    <span className="font-semibold">{x.town}</span>
                    <span>{word(t.hunt.cov.sources, x.source)}</span>
                    <Badge tone={OUTCOME_TONE[x.outcome] ?? "neutral"}>{word(R.outcomes, x.outcome)}</Badge>
                    {x.reason && <span className="text-[#4a5361]">{x.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {s.blockers.length > 0 && (
            <div className="flex flex-col gap-1"><span className={small}>{R.blockers}</span><ul className="m-0 list-disc pl-5 text-base">{s.blockers.map((c) => <li key={c}>{word(R.blockerCodes, c)}</li>)}</ul></div>
          )}
          {s.asks.length > 0 && (
            <div className="flex flex-col gap-1"><span className={small}>{R.asks}</span><ul className="m-0 list-disc pl-5 text-base">{s.asks.map((c) => <li key={c}>{word(R.askCodes, c)}</li>)}</ul></div>
          )}
        </>
      )}
      {r.stop_reason && (
        <p className="m-0 border-l-4 border-honey pl-3 text-base font-semibold"><span className={`${small} block`}>{R.stopped}</span>{word(R.stop, r.stop_reason)}</p>
      )}
    </HexPanel>
  );
}

/** The saved conversation in time order: your instructions, the Hunter's answers and one card per finished round. */
export async function CampaignThread({ messages, rounds }: { messages: ThreadMessage[]; rounds: ThreadRound[] }) {
  const t = await getT();
  const items = [
    ...messages.map((m) => ({ at: m.created_at, kind: 0, m, r: null as ThreadRound | null })),
    ...rounds.map((r) => ({ at: r.ended_at ?? "9999", kind: 1, m: null as ThreadMessage | null, r })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind - b.kind);
  if (items.length === 0) return <p className="m-0 text-base text-[#4a5361]">{t.hunt.campaign.empty}</p>;
  return (
    <div className="flex flex-col gap-4" data-testid="campaign-thread">
      {items.map((i) =>
        i.r ? <RoundCard key={`r${i.r.id}`} r={i.r} /> : i.m!.role === "user" ? (
          <UserBubble key={i.m!.id}><span className="block whitespace-pre-line">{i.m!.body}</span></UserBubble>
        ) : (
          <AiBubble key={i.m!.id} label={t.hunt.campaign.agent}><p className="m-0 whitespace-pre-line text-base leading-normal">{i.m!.body}</p></AiBubble>
        ),
      )}
    </div>
  );
}
