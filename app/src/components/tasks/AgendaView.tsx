"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { rescheduleTaskAction, setTaskDoneAction } from "@/app/(app)/inicio/agenda/actions";
import { HexCard, HexCta, ICON, Icon } from "@/components/home/bits";
import {
  AGENDA_KINDS,
  agendaHref,
  AGENDA_VIEWS,
  byDay,
  filterAgenda,
  isLate,
  kindGroup,
  shiftMonth,
  type AgendaItem,
  type AgendaKind,
  type AgendaState,
  type Who,
} from "@/lib/agenda/view";
import { nyDay } from "@/lib/calls/ny-day";
import type { Person } from "@/lib/team/types";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { AppointmentDialog, type LeadOption } from "./AppointmentDialog";

export type AgendaRow = AgendaItem & { name: string };

/** Navy for call-backs, honey for meetings, blue-grey for e-mails (text is always readable: white only on navy). */
const KIND_STYLE: Record<AgendaKind, string> = {
  returns: "bg-ink text-white",
  meetings: "bg-honey text-ink",
  emails: "bg-[#e3e9f5] text-ink",
};
const KIND_DOT: Record<AgendaKind, string> = { returns: "bg-ink", meetings: "bg-honey", emails: "bg-[#9fb0d4]" };

const utc = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const nyTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const cap = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const longDay = (day: string, t: Messages) =>
  cap(new Intl.DateTimeFormat(t.intl, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(utc(day)).replace("-feira", ""));
const shortWeekday = (day: string, t: Messages) => cap(new Intl.DateTimeFormat(t.intl, { timeZone: "UTC", weekday: "short" }).format(utc(day)).replace(".", ""));

/** The Agenda: month / week / list of the user's tasks, a side panel for the chosen day, and the new-task dialog. */
export function AgendaView({ state, grid, items, people, me, leads }: { state: AgendaState; grid: string[][]; items: AgendaRow[]; people: Person[] | null; me: string; leads: LeadOption[] }) {
  const t = useT();
  const A = t.home.agenda;
  const [kinds, setKinds] = useState<Set<AgendaKind>>(new Set(AGENDA_KINDS));
  const [who, setWho] = useState<Who>("all");
  const [adding, setAdding] = useState(false);
  const month = `${state.year}-${String(state.month).padStart(2, "0")}`;
  const mine = useMemo(() => filterAgenda(items, new Set(AGENDA_KINDS), who, me), [items, who, me]);
  const shown = useMemo(() => filterAgenda(mine, kinds, "all", me), [mine, kinds, me]);
  const days = useMemo(() => byDay(shown), [shown]);
  const on = (day: string) => days.get(day) ?? [];
  const title = cap(new Intl.DateTimeFormat(t.intl, { timeZone: "UTC", month: "long", year: "numeric" }).format(Date.UTC(state.year, state.month - 1, 1)));
  const week = grid.find((w) => w.includes(state.day)) ?? grid[0];
  const whoLabel = (id: string | null) => {
    if (id === me) return A.you;
    if (!id) return A.nobody;
    const p = people?.find((x) => x.user_id === id);
    return p ? (p.label === p.role ? t.team.roles[p.role] : p.label) : A.team;
  };
  const navBtn = "k-btn inline-flex size-[46px] items-center justify-center rounded-[12px] border-2 border-line bg-surface text-ink";
  const hexNum = (day: string, size: string) =>
    `hxv inline-flex ${size} items-center justify-center ${day === state.today ? "bg-honey font-bold" : ""}`;
  const dayLabel = (day: string) => {
    const evs = on(day);
    const n = evs.length;
    // the first three, so a screen reader hears what is on the day without opening it
    const what = evs.slice(0, 3).map((x) => `${nyTime(x.due_at)} ${A.kindLabels[kindGroup(x.kind)]} ${x.name}`);
    return [longDay(day, t), n === 1 ? A.itemsOne : fill(A.items, { n }), ...what, ...(day === state.today ? [A.todaySr] : []), ...(day === state.day ? [A.selected] : [])].join(", ");
  };

  return (
    <>
      <div className="k-in flex flex-wrap items-center justify-between gap-3.5 [animation-delay:.05s]">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={agendaHref(`${shiftMonth(state.year, state.month, -1)}-01`, state.view)} aria-label={A.prev} className={navBtn} scroll={false}>
            <Icon d={ICON.left} w={2.4} />
          </Link>
          <h1 className="mx-1.5 min-w-[230px] text-center text-[34px] font-extrabold leading-none">{title}</h1>
          <Link href={agendaHref(`${shiftMonth(state.year, state.month, 1)}-01`, state.view)} aria-label={A.next} className={navBtn} scroll={false}>
            <Icon d={ICON.right} w={2.4} />
          </Link>
          <Link href={agendaHref(state.today, state.view)} scroll={false} className="k-btn ml-1 inline-flex min-h-[46px] items-center rounded-[12px] border-2 border-ink bg-surface px-4 font-semibold text-ink no-underline">
            {A.today}
          </Link>
        </div>
        <nav aria-label={A.views.label} className="inline-flex gap-1 rounded-[14px] bg-[#e9ecf1] p-1">
          {AGENDA_VIEWS.map((v) => (
            <Link key={v} href={agendaHref(state.day, v)} scroll={false} aria-current={state.view === v ? "true" : undefined} className={`k-btn inline-flex min-h-11 items-center rounded-[11px] px-[18px] no-underline ${state.view === v ? "bg-ink font-semibold text-white" : "font-medium text-ink"}`}>
              {A.views[v]}
            </Link>
          ))}
        </nav>
      </div>
      <p className="-mt-2 mb-0 text-[17px] text-[#4a5361]">{A.subtitle}</p>

      <div className="k-in flex flex-wrap items-center gap-2 [animation-delay:.1s]">
        <span className="mr-1 text-base text-[#4a5361]">{A.show}</span>
        {AGENDA_KINDS.map((k) => {
          const pressed = kinds.has(k);
          return (
            <button
              key={k}
              type="button"
              aria-pressed={pressed}
              onClick={() => setKinds((s) => { const n = new Set(s); if (pressed) n.delete(k); else n.add(k); return n; })}
              className={`k-btn inline-flex min-h-11 items-center gap-2 rounded-full border-2 pl-3 pr-4 text-base text-ink ${pressed ? "border-ink bg-surface font-semibold" : "border-line bg-ground"}`}
            >
              <span aria-hidden className={`hxv h-4 w-3.5 ${pressed ? KIND_DOT[k] : "bg-[#c9cfd8]"}`} />
              {A.kinds[k]}
              <span className="font-mono text-[13px] text-[#4a5361]">{mine.filter((x) => kindGroup(x.kind) === k).length}</span>
            </button>
          );
        })}
        {people && (
          <label className="ml-auto inline-flex items-center gap-2 text-base text-[#4a5361]">
            {A.who}
            <select value={who} onChange={(e) => setWho(e.target.value)} className="k-field min-h-11 rounded-[12px] border-2 border-line bg-surface px-2.5 text-ink">
              <option value="all">{A.whoAll}</option>
              <option value="mine">{A.whoMine}</option>
              {people.filter((p) => p.user_id !== me).map((p) => <option key={p.user_id} value={p.user_id}>{whoLabel(p.user_id)}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <HexCard c={18} className="k-in min-w-0 flex-[999_1_640px] [animation-delay:.15s]" aria-label={title} innerClassName="px-5 pb-5 pt-4 md:px-[30px]">
          {state.view === "mes" && (
            <div key="mes" className="k-fade overflow-x-auto">
              <table className="w-full min-w-[620px] table-fixed border-separate border-spacing-1.5">
                <thead>
                  <tr>
                    {grid[0].map((d) => (
                      <th key={d} scope="col" className="px-2 py-1 text-left font-mono text-[13px] font-normal text-[#4a5361]">{shortWeekday(d, t)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.map((w) => (
                    <tr key={w[0]}>
                      {w.map((d) => {
                        const evs = on(d);
                        const inMonth = d.startsWith(month);
                        const sel = d === state.day;
                        return (
                          <td key={d} className="p-0 align-top">
                            <Link
                              href={agendaHref(d, state.view)}
                              scroll={false}
                              aria-label={dayLabel(d)}
                              aria-current={d === state.today ? "date" : undefined}
                              className={`k-btn flex min-h-[104px] flex-col gap-1 rounded-[12px] border-2 p-1.5 text-ink no-underline ${sel ? "border-ink bg-honey-soft" : inMonth ? "border-[#eef0f3] bg-surface" : "border-[#eef0f3] bg-[#f9fafb] text-[#4a5361]"}`}
                            >
                              <span className="flex items-center justify-between">
                                <span className={`${hexNum(d, "h-[31px] w-7")} text-sm ${sel ? "font-bold" : "font-medium"}`}>{+d.slice(8, 10)}</span>
                                {evs.some((x) => isLate(x, state.today)) && <span className="rounded-full bg-warn-soft px-[7px] py-px text-xs font-semibold text-warn">{A.late}</span>}
                              </span>
                              {evs.slice(0, 2).map((x) => (
                                <span key={x.id} className={`block truncate rounded-[7px] px-[7px] py-[3px] text-[13px] leading-tight ${KIND_STYLE[kindGroup(x.kind)]} ${x.done_at ? "line-through" : ""}`}>
                                  <span className="font-mono">{nyTime(x.due_at)}</span> {x.name}
                                </span>
                              ))}
                              {evs.length > 2 && <span className="pl-1 text-[13px] text-[#4a5361]">{fill(A.more, { n: evs.length - 2 })}</span>}
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {state.view === "semana" && (
            <div key="semana" className="k-fade overflow-x-auto">
              <div className="grid min-w-[620px] grid-cols-7 gap-2">
                {week.map((d) => (
                  <div key={d} className="flex min-w-0 flex-col gap-1.5">
                    <Link href={agendaHref(d, state.view)} scroll={false} aria-label={dayLabel(d)} aria-current={d === state.today ? "date" : undefined} className={`k-btn flex flex-col items-center gap-0.5 rounded-[12px] border-2 px-1 py-2 text-ink no-underline ${d === state.day ? "border-ink bg-honey-soft" : "border-[#eef0f3] bg-surface"}`}>
                      <span className="font-mono text-[13px] text-[#4a5361]">{shortWeekday(d, t)}</span>
                      <span className={`${hexNum(d, "h-[38px] w-[34px]")} text-[17px] font-bold`}>{+d.slice(8, 10)}</span>
                    </Link>
                    {on(d).map((x) => (
                      <span key={x.id} className={`flex flex-col gap-0.5 rounded-[10px] px-2 py-2 text-sm leading-tight ${KIND_STYLE[kindGroup(x.kind)]} ${x.done_at ? "line-through" : ""}`}>
                        <span className="font-mono text-[13px]">{nyTime(x.due_at)}</span>
                        <span className="font-semibold">{x.name}</span>
                        <span className="text-xs">{A.kindLabels[kindGroup(x.kind)]}</span>
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {state.view === "lista" && (
            <div key="lista" className="k-fade flex flex-col gap-[18px]">
              {grid.flat().filter((d) => d.startsWith(month) && on(d).length > 0).length === 0 && <p className="m-0 rounded-[12px] bg-ground p-4 text-[#4a5361]">{A.emptyMonth}</p>}
              {grid.flat().filter((d) => d.startsWith(month) && on(d).length > 0).map((d) => (
                <section key={d} aria-labelledby={`ag-${d}`} className="flex flex-col gap-1">
                  <h3 id={`ag-${d}`} className="m-0 flex items-center gap-2.5 text-[17px] font-semibold">
                    <span aria-hidden className={`hxv inline-flex h-[33px] w-[30px] items-center justify-center text-sm ${d === state.today ? "bg-honey" : "bg-[#eef0f4]"}`}>{+d.slice(8, 10)}</span>
                    {longDay(d, t)}{d === state.today ? ` · ${A.todaySr}` : ""}
                  </h3>
                  {on(d).map((x) => (
                    <Link key={x.id} href={agendaHref(d, "lista")} scroll={false} className="k-row flex flex-wrap items-center gap-3.5 rounded-[12px] px-3 py-2.5 text-ink no-underline">
                      <span className="w-[54px] font-mono text-[15px]">{nyTime(x.due_at)}</span>
                      <span className={`inline-flex min-w-[120px] items-center rounded-full px-2.5 py-[3px] text-sm font-semibold ${KIND_STYLE[kindGroup(x.kind)]}`}>{A.kindLabels[kindGroup(x.kind)]}</span>
                      <span className={`min-w-0 flex-1 font-semibold ${x.done_at ? "line-through decoration-honey decoration-2" : ""}`}>{x.name}</span>
                      <span className="text-[15px] text-[#4a5361]">{whoLabel(x.assignee_id)}</span>
                    </Link>
                  ))}
                </section>
              ))}
            </div>
          )}
        </HexCard>

        <HexCard c={16} className="k-in min-w-0 flex-[1_1_340px] [animation-delay:.2s]" aria-label={A.day} innerClassName="flex flex-col gap-3.5 px-6 pb-6 pt-[22px] md:px-[30px]">
          <DayPanel key={state.day} day={state.day} today={state.today} items={on(state.day)} whoLabel={whoLabel} />
          <button type="button" onClick={() => setAdding(true)} className="k-lift flex self-stretch">
            <HexCta className="flex-1">
              <Icon d={ICON.plus} w={2.4} />
              {A.add}
            </HexCta>
          </button>
        </HexCard>
      </div>

      <AppointmentDialog open={adding} onClose={() => setAdding(false)} leads={leads} day={state.day < state.today ? state.today : state.day} people={people} me={me} />
    </>
  );
}

function DayPanel({ day, today, items, whoLabel }: { day: string; today: string; items: AgendaRow[]; whoLabel: (id: string | null) => string }) {
  const t = useT();
  const A = t.home.agenda;
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  // focus goes into the reschedule form when it opens and back to its "Remarcar" button when it closes
  const opener = useRef<HTMLButtonElement | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) firstField.current?.focus();
    else if (wasEditing.current) opener.current?.focus();
    wasEditing.current = editing !== null;
  }, [editing]);
  const [when, setWhen] = useState({ d: "", tm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.message ?? t.tasks.failed);
      setEditing(null);
      router.refresh();
    });
  const field = "k-field min-h-11 rounded-[10px] border-2 border-line bg-surface px-2 text-base text-ink";

  return (
    <div className="k-fade flex flex-col gap-3.5">
      <div>
        <span className="font-mono text-[13px] tracking-[0.06em] text-[#4a5361]">{day === today ? A.selTag.today : day < today ? A.selTag.past : A.selTag.future}</span>
        <h2 className="mt-0.5 text-[28px] font-extrabold leading-tight">{longDay(day, t)}</h2>
      </div>
      {items.length === 0 && <p className="m-0 rounded-[12px] bg-ground p-4 text-[#4a5361]">{A.empty}</p>}
      {error && <p role="alert" className="m-0 rounded-[12px] bg-warn-soft px-3 py-2.5 text-[15px] text-warn">{error}</p>}
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {items.map((x) => {
          const k = kindGroup(x.kind);
          const late = isLate(x, today);
          const done = x.done_at !== null;
          const href = k === "returns" ? `/leads/ligar/${x.lead_id}` : `/leads?lead=${x.lead_id}`;
          return (
            <li key={x.id} className={`flex flex-col gap-2 rounded-[14px] border-2 bg-surface p-3.5 ${late ? "border-honey-edge" : "border-[#e3e6ec]"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2">
                  <span className="font-mono text-[15px] font-medium">{nyTime(x.due_at)}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${KIND_STYLE[k]}`}>{A.kindLabels[k]}</span>
                </span>
                {late && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-[13px] font-semibold text-warn">{A.lateBadge}</span>}
              </div>
              <span className={`text-lg font-semibold ${done ? "text-[#4a5361] line-through decoration-honey decoration-2" : ""}`}>{x.name}</span>
              <span className="text-[15px] text-[#4a5361]">{[x.title || t.tasks.defaultTitle[x.kind], whoLabel(x.assignee_id)].join(" · ")}</span>
              {editing === x.id ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(() => rescheduleTaskAction(x.id, when.d, when.tm));
                  }}
                >
                  <label className="flex flex-col gap-1 text-sm text-[#4a5361]">
                    {A.date}
                    <input ref={firstField} type="date" required value={when.d} onChange={(e) => setWhen({ ...when, d: e.target.value })} className={field} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-[#4a5361]">
                    {A.time}
                    <input type="time" required value={when.tm} onChange={(e) => setWhen({ ...when, tm: e.target.value })} className={field} />
                  </label>
                  <button type="submit" disabled={busy} className="k-btn inline-flex min-h-11 items-center rounded-[11px] bg-ink px-4 font-semibold text-white">{A.save}</button>
                  <button type="button" onClick={() => setEditing(null)} className="k-btn inline-flex min-h-11 items-center rounded-[11px] border-2 border-line px-3.5 text-ink">{A.cancel}</button>
                </form>
              ) : (
                <div className="mt-0.5 flex flex-wrap gap-1.5">
                  <Link href={href} className="k-btn inline-flex min-h-11 items-center rounded-[11px] bg-ink px-4 text-[15px] font-semibold text-white no-underline">{A.actions[k]}</Link>
                  <button
                    type="button"
                    aria-label={fill(A.rescheduleFor, { name: x.name })}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      // an overdue one starts on today, not its old day (which the server would refuse)
                      setWhen({ d: late ? today : nyDay(new Date(x.due_at)), tm: nyTime(x.due_at) });
                      setEditing(x.id);
                    }}
                    className="k-btn inline-flex min-h-11 items-center rounded-[11px] border-2 border-line bg-surface px-3.5 text-[15px] text-ink"
                  >
                    {A.reschedule}
                  </button>
                  <button
                    type="button"
                    aria-pressed={done}
                    disabled={busy}
                    onClick={() => run(() => setTaskDoneAction(x.id, !done))}
                    className={`k-btn inline-flex min-h-11 items-center rounded-[11px] border-2 px-3.5 text-[15px] font-semibold text-ink ${done ? "border-honey bg-honey-light" : "border-line bg-surface"}`}
                  >
                    {done ? A.done : A.markDone}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
