"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markItemAction, saveDayPlanAction } from "@/app/(app)/inicio/actions";
import { HexIcon } from "@/components/leads/hex";
import { nyDay } from "@/lib/calls/ny-day";
import { AppointmentDialog, type LeadOption } from "@/components/tasks/AppointmentDialog";
import { buildPlan, moveBlock, type BlockId, type DayPlan as Plan, type PlanInput, type PlanItem } from "@/lib/home/plan";
import { ruleInWords, type HomeRule } from "@/lib/home/rule";
import type { Person } from "@/lib/team/types";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { HexCard, HexCta, ICON, Icon } from "./bits";
import { PlanConfig } from "./PlanConfig";

/** The words of an item: its title, tag and the line under it, from the builder's structured reason. */
export function itemWords(i: PlanItem, t: Messages) {
  const P = t.home.plan;
  const r = i.reason;
  const plural = (one: string, many: string, n: number) => (n === 1 ? one : fill(many, { n }));
  if (r.t === "review" && r.kind !== "meetingNoDate") {
    const R = P.review;
    const title = r.kind === "newYesterday" ? plural(R.newYesterdayOne, R.newYesterday, r.n) : r.kind === "bigNoContact" ? plural(R.bigNoContactOne, R.bigNoContact, r.n) : plural(R.noTypeOne, R.noType, r.n);
    return { title, tag: t.home.config.review[r.kind], meta: P.reviewMeta[r.kind] };
  }
  const tag =
    r.t === "late" ? plural(P.reasons.lateOne, P.reasons.late, r.days)
    : r.t === "today" ? fill(P.reasons.today, { at: r.at })
    : r.t === "tomorrow" ? fill(P.reasons.tomorrow, { at: r.at })
    : r.t === "fresh" ? (i.segment ? fill(P.reasons.fresh, { type: t.leads.segments[i.segment] }) : P.reasons.freshNone)
    : r.t === "noAnswer" ? fill(P.reasons.noAnswer, { n: r.n })
    : r.t === "noPhone" ? P.reasons.noPhone
    : r.t === "silent" ? P.reasons.silent
    : P.review.meetingNoDate;
  const meta = [i.city ?? P.noCity, ...(i.segment && r.t !== "fresh" ? [t.leads.segments[i.segment]] : []), ...(i.note ? [i.note] : []), ...(r.t === "review" ? [P.reviewMeta.meetingNoDate] : [])].join(" · ");
  return { title: i.name, tag, meta };
}

/** "Ligar para Bruin Corp (atrasado 1 dia)." */
function nextSentence(i: PlanItem, t: Messages) {
  const w = itemWords(i, t);
  return i.action === "look" ? `${fill(t.home.plan.verbs.look, { name: w.title.toLocaleLowerCase(t.intl) })}.` : `${fill(t.home.plan.verbs[i.action], { name: w.title })} (${w.tag.toLocaleLowerCase(t.intl)}).`;
}

type Props = {
  input: PlanInput;
  plan: Plan;
  rule: HomeRule;
  dateLine: string;
  cities: string[];
  origins: string[];
  people: Person[] | null;
};

/** "Plano de hoje": the hero (progress + next step) and the user's blocks, each with its items and their tick. */
export function DayPlan({ input, plan: savedPlan, rule: savedRule, dateLine, cities, origins, people }: Props) {
  const t = useT();
  const P = t.home.plan;
  const router = useRouter();
  const [plan, setPlan] = useState(savedPlan);
  const [rule, setRule] = useState(savedRule);
  const [marks, setMarks] = useState(input.marks);
  // a refresh brings the server's truth back (React's "adjust state when a prop changes" pattern)
  const [seen, setSeen] = useState({ savedPlan, savedRule, marks: input.marks });
  if (seen.savedPlan !== savedPlan || seen.savedRule !== savedRule || seen.marks !== input.marks) {
    setSeen({ savedPlan, savedRule, marks: input.marks });
    setPlan(savedPlan);
    setRule(savedRule);
    setMarks(input.marks);
  }
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const [config, setConfig] = useState<BlockId | null>(null);
  const [meeting, setMeeting] = useState<LeadOption | null>(null);
  const built = useMemo(() => buildPlan({ ...input, marks }, plan, rule), [input, marks, plan, rule]);
  const visible = built.blocks.filter((b) => !b.hidden);
  const all = visible.flatMap((b) => b.items);

  const toggle = (i: PlanItem) => {
    if (i.real) return;
    const on = !i.done;
    const before = marks;
    setMarks(on ? [...marks, i.key] : marks.filter((k) => k !== i.key));
    setError(null);
    start(async () => {
      const r = await markItemAction(i.key, on);
      if (!r.ok) {
        setMarks(before);
        setError(r.message ?? P.failed);
      } else router.refresh();
    });
  };
  const move = (id: BlockId, dir: -1 | 1) => {
    const before = plan;
    const next = { ...plan, order: moveBlock(plan.order, id, dir) };
    setPlan(next);
    setError(null);
    start(async () => {
      const r = await saveDayPlanAction({ plan: next });
      if (!r.ok) {
        setPlan(before);
        setError(r.message ?? P.failed);
      }
    });
  };

  const openItem = (i: PlanItem, primary: boolean, big = false) => {
    const label = big ? fill(P.nextCta, { action: P.actions[i.action] }) : P.actions[i.action];
    const inner = big ? (
      <HexCta className="text-lg">
        {label}
        <Icon d={ICON.right} w={2.4} className="k-arrow" />
      </HexCta>
    ) : (
      <>
        <Icon d={ICON[i.action]} />
        {label}
      </>
    );
    const cls = big ? "k-lift flex text-ink no-underline" : `k-btn inline-flex min-h-12 items-center gap-2 rounded-[12px] border-2 border-ink px-[18px] font-semibold no-underline ${primary ? "bg-ink text-white" : "bg-surface text-ink"}`;
    const name = itemWords(i, t).title;
    return i.action === "meeting" ? (
      <button type="button" onClick={() => i.leadId && setMeeting({ id: i.leadId, name: i.name, city: i.city })} aria-label={big ? undefined : `${label}: ${name}`} className={cls}>
        {inner}
      </button>
    ) : (
      <Link href={i.href ?? "/leads"} aria-label={big ? undefined : `${label}: ${name}`} className={cls}>
        {inner}
      </Link>
    );
  };

  const next = built.next;
  const whyOf = (id: BlockId) => (id === "call" ? ruleInWords(rule, t) : P.blocks[id].why);

  return (
    <>
      <h1 className="sr-only">{P.title}</h1>
      <div className="k-in drop-shadow-[0_18px_22px_rgba(15,27,61,0.28)]">
        <section aria-label={P.title} className="hx flex flex-wrap items-center justify-between gap-6 bg-ink px-7 py-7 text-white [--c:14px] md:px-12 md:[--c:24px]">
          <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-2.5">
            <span className="font-mono text-sm tracking-[0.08em] text-honey">{fill(P.heroTag, { date: dateLine })}</span>
            <p className="m-0 font-display text-[40px] font-extrabold leading-none">
              <span className="text-honey">{built.done}</span> {fill(P.of, { total: built.total })}
            </p>
            {built.total > 0 && (
              <div role="img" aria-label={fill(P.progress, { done: built.done, total: built.total })} className="mt-1 flex flex-wrap gap-1.5">
                {all.map((i) => (
                  <span key={i.key} className={`hxv h-[22px] w-5 transition-transform motion-reduce:transition-none ${i.done ? "bg-honey" : "scale-[0.86] bg-white/20"}`} />
                ))}
              </div>
            )}
            <p key={next?.key ?? "none"} aria-live="polite" className="k-fade m-0 mt-1.5 text-lg text-[#d5dae6]">
              {next ? (
                <>
                  <b className="font-semibold text-white">{P.next}</b> {nextSentence(next, t)}
                </>
              ) : built.total > 0 ? P.allDone : P.nothing}
            </p>
            {!next && built.queue.length > 0 && (
              <div className="mt-1 flex flex-col gap-1.5">
                <span className="font-mono text-[13px] tracking-[0.06em] text-honey">{P.queue}</span>
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                  {built.queue.map((q) => (
                    <li key={q.key}>
                      <Link href={q.href ?? "/leads"} className="k-btn inline-flex min-h-11 items-center gap-2 rounded-[12px] border-2 border-white/40 px-4 font-semibold text-white no-underline">
                        <Icon d={ICON.call} />
                        {fill(P.verbs.call, { name: q.name })}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {next && openItem(next, true, true)}
            <button type="button" onClick={() => setConfig(plan.order[0])} className="k-btn inline-flex min-h-12 items-center gap-2 rounded-[12px] border-2 border-white/50 px-4 font-semibold text-white">
              <Icon d={ICON.sliders} />
              {P.setup}
            </button>
          </div>
        </section>
      </div>

      {error && <p role="alert" className="m-0 rounded-[12px] bg-warn-soft px-4 py-3 text-[15px] text-warn">{error}</p>}

      {visible.map((b, bi) => {
        const B = P.blocks[b.id];
        const done = b.items.filter((i) => i.done).length;
        const pos = plan.order.indexOf(b.id);
        const arrow = "k-btn inline-flex size-[42px] items-center justify-center rounded-[9px] bg-surface text-ink disabled:opacity-35";
        return (
          <HexCard key={b.id} aria-labelledby={`blk-${b.id}`} className="k-in" style={{ animationDelay: `${0.16 + bi * 0.07}s` }} innerClassName="flex flex-col gap-3.5 px-6 pb-5 pt-6 md:px-[38px]">
            <div className="k-step flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <HexIcon n={bi + 1} size={36} turn />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h2 id={`blk-${b.id}`} className="flex flex-wrap items-center gap-2.5 font-body text-[21px] font-semibold normal-case tracking-normal">
                    {B.title}
                    <span className="rounded-full bg-[#eef0f4] px-2.5 py-0.5 font-mono text-sm font-normal text-[#4a5361]">{fill(P.count, { done, total: b.items.length })}</span>
                  </h2>
                  <p className="m-0 text-base text-[#4a5361]">{whyOf(b.id)}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <div role="group" aria-label={fill(P.priority, { name: B.title })} className="inline-flex gap-[3px] rounded-[12px] bg-[#eef0f4] p-[3px]">
                  <button type="button" aria-label={fill(P.up, { name: B.title })} disabled={pos === 0} onClick={() => move(b.id, -1)} className={arrow}>
                    <Icon d={ICON.up} w={2.4} />
                  </button>
                  <button type="button" aria-label={fill(P.down, { name: B.title })} disabled={pos === plan.order.length - 1} onClick={() => move(b.id, 1)} className={arrow}>
                    <Icon d={ICON.down} w={2.4} />
                  </button>
                </div>
                <button type="button" onClick={() => setConfig(b.id)} className="k-btn inline-flex min-h-12 items-center gap-2 rounded-[12px] border-2 border-line bg-surface px-4 text-base font-semibold text-ink">
                  <Icon d={ICON.sliders} />
                  {P.choose}
                </button>
              </div>
            </div>
            {b.items.length === 0 ? (
              <p className="m-0 rounded-[12px] bg-ground px-4 py-3.5 text-base text-[#4a5361]">{B.empty}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {b.items.map((i) => {
                  const w = itemWords(i, t);
                  return (
                    <li key={i.key} className="k-row flex flex-wrap items-center gap-3.5 rounded-[14px] py-3 pl-2.5 pr-3">
                      <button
                        type="button"
                        aria-pressed={i.done}
                        aria-disabled={i.real || undefined}
                        aria-label={fill(i.real ? P.realDone : i.done ? P.unmark : P.mark, { name: w.title })}
                        onClick={() => toggle(i)}
                        className={`k-btn inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] ${i.real ? "cursor-default" : ""}`}
                      >
                        <span className={`hxv inline-flex h-[34px] w-[30px] items-center justify-center ${i.done ? "bg-honey" : "bg-[#8a93a6]"}`}>
                          <span className={`hxv inline-flex h-[30px] w-[26px] items-center justify-center text-ink ${i.done ? "bg-honey" : "bg-surface"}`}>
                            {i.done && <Icon d={ICON.check} size={16} w={3.2} className="k-pop" />}
                          </span>
                        </span>
                      </button>
                      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
                        <span className={`text-lg font-semibold ${i.done ? "text-[#4a5361] line-through decoration-honey decoration-2" : ""}`}>{w.title}</span>
                        <span className="flex flex-wrap items-center gap-2 text-[15px] text-[#4a5361]">
                          <span className={`inline-flex items-center gap-1.5 rounded-full py-[3px] pl-2 pr-2.5 font-medium text-ink ${i.hot ? "bg-honey-pill" : "bg-[#eef0f4]"}`}>
                            <span aria-hidden className={`size-2 rounded-full ${i.hot ? "bg-honey" : "bg-[#8a93a6]"}`} />
                            {w.tag}
                          </span>
                          {w.meta}
                        </span>
                      </div>
                      {openItem(i, !i.done && next?.key === i.key)}
                    </li>
                  );
                })}
              </ul>
            )}
          </HexCard>
        );
      })}

      {visible.length > 0 && <p className="k-in m-0 mt-1 text-center text-base text-[#4a5361] [animation-delay:.5s]">{P.footer}</p>}

      <PlanConfig
        open={config !== null}
        start={config ?? plan.order[0]}
        onClose={() => setConfig(null)}
        onSaved={(p, r) => {
          setPlan(p);
          setRule(r);
          router.refresh();
        }}
        input={input}
        plan={plan}
        rule={rule}
        cities={cities}
        origins={origins}
      />
      <AppointmentDialog open={meeting !== null} onClose={() => setMeeting(null)} lead={meeting} kind="meeting" day={nyDay(new Date(input.now))} people={people} me={input.userId} />
    </>
  );
}
