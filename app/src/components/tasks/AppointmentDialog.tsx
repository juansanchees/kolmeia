"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTaskAction } from "@/app/(app)/inicio/agenda/actions";
import { Chip, HexCta, PanelHead, SidePanel } from "@/components/home/bits";
import { NEW_TASK_KINDS, type NewTaskKind } from "@/lib/agenda/view";
import { nyDay } from "@/lib/calls/ny-day";
import { fold } from "@/lib/leads/classify";
import type { Person } from "@/lib/team/types";
import { useT } from "@/lib/i18n/client";

/** `owner`: the user the lead is assigned to (a closer can only be given tasks on her own leads). */
export type LeadOption = { id: string; name: string; city: string | null; owner: string | null };

/** 09:00, or the next full hour when the day is today in New York (never past 23:00). */
export function defaultTime(day: string, now = new Date()): string {
  if (day !== nyDay(now)) return "09:00";
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now));
  return `${String(Math.min(23, h + 1)).padStart(2, "0")}:00`;
}

const field = "k-field min-h-12 rounded-[12px] border-2 border-line bg-surface px-3 text-base text-ink";
const label = "flex flex-col gap-1.5 text-[15px] text-[#4a5361]";
const step = "m-0 font-mono text-[13px] tracking-[0.06em] text-[#4a5361]";

/**
 * "Marcar retorno ou reunião": pick a lead (or get one given), the kind, New York day and time, a note and, for
 * senders, who does it. Saves through createTaskAction (validated there and by RLS), then refreshes the page.
 */
export function AppointmentDialog({
  open,
  onClose,
  leads = [],
  lead = null,
  kind = "call",
  day,
  people,
  me,
}: {
  open: boolean;
  onClose: () => void;
  leads?: LeadOption[];
  lead?: LeadOption | null;
  kind?: NewTaskKind;
  /** yyyy-mm-dd (New York). */
  day: string;
  /** null = the closer: no "Quem faz", it is always her. */
  people: Person[] | null;
  me: string;
}) {
  const t = useT();
  const F = t.tasks.form;
  return (
    <SidePanel open={open} onClose={onClose} labelledBy="appt-title" width={620}>
      <PanelHead id="appt-title" title={F.title} intro={F.intro} close={F.close} onClose={onClose} />
      {/* remount per opening: the form starts from the given lead, kind and day */}
      <Form key={`${lead?.id ?? ""}-${kind}-${day}`} onClose={onClose} leads={leads} lead={lead} kind={kind} day={day} people={people} me={me} />
    </SidePanel>
  );
}

function Form({ onClose, leads, lead, kind, day, people, me }: { onClose: () => void; leads: LeadOption[]; lead: LeadOption | null; kind: NewTaskKind; day: string; people: Person[] | null; me: string }) {
  const t = useT();
  const F = t.tasks.form;
  const router = useRouter();
  const [picked, setPicked] = useState<LeadOption | null>(lead);
  const [q, setQ] = useState("");
  const [k, setK] = useState<NewTaskKind>(kind);
  const [date, setDate] = useState(day);
  const [time, setTime] = useState(() => defaultTime(day));
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(me);
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const matches = useMemo(() => {
    const f = fold(q.trim());
    return f ? leads.filter((l) => fold(l.name).includes(f)).slice(0, 8) : [];
  }, [q, leads]);
  const who = (p: Person) => (p.user_id === me ? F.me : p.label === p.role ? t.team.roles[p.role] : p.label);
  // senders, plus the closer the lead is assigned to (another closer would never see the task)
  const can = (p: Person, l: LeadOption | null) => p.role !== "closer" || p.user_id === l?.owner;
  const choices = (people ?? []).filter((p) => can(p, picked));
  const kindRef = useRef<HTMLDivElement>(null);
  const pick = (l: LeadOption | null) => {
    setPicked(l);
    if (people && !people.some((p) => p.user_id === assignee && can(p, l))) setAssignee(me);
    // focus moves to the next field once the company is chosen
    if (l) requestAnimationFrame(() => kindRef.current?.querySelector("button")?.focus());
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      if (!picked) return setError(F.needLead);
      const r = await createTaskAction({ leadId: picked.id, kind: k, date, time, note, assignee: people ? assignee : null });
      if (!r.ok) return setError(r.message ?? F.failed);
      router.refresh();
      onClose();
    });
  };

  return (
    <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5 md:px-10">
        <section className="flex flex-col gap-2.5">
          <h3 className={step}>{F.lead}</h3>
          {picked ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3">
              <span>
                <b className="font-semibold">{picked.name}</b>
                {picked.city && <span className="text-[15px] text-[#4a5361]"> · {picked.city}</span>}
              </span>
              {!lead && (
                <button type="button" onClick={() => pick(null)} className="k-btn k-link min-h-11 rounded-[10px] px-2 font-semibold underline">
                  {F.change}
                </button>
              )}
            </div>
          ) : (
            <>
              <label className={label}>
                {F.search}
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
                  // Enter in the search picks the first match instead of sending the form
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (matches[0]) pick(matches[0]);
                }} placeholder={F.searchPh} maxLength={120} className={field} autoFocus />
              </label>
              <div aria-live="polite">
              {q.trim() && matches.length === 0 && <p className="m-0 text-[15px] text-[#4a5361]">{F.noMatch}</p>}
              {matches.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {matches.map((l) => (
                    <li key={l.id}>
                      <button type="button" onClick={() => pick(l)} className="k-row flex min-h-12 w-full items-center justify-between gap-3 rounded-[12px] px-3 text-left text-ink">
                        <span className="font-semibold">{l.name}</span>
                        <span className="text-[15px] text-[#4a5361]">{l.city ?? ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-2.5">
          <h3 className={step}>{F.kind}</h3>
          <div ref={kindRef} role="group" aria-label={F.kind} className="flex flex-wrap gap-2">
            {NEW_TASK_KINDS.map((x) => (
              <Chip key={x} on={k === x} onClick={() => setK(x)}>{F.kinds[x]}</Chip>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className={step}>{F.when}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              {F.date}
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={field} />
            </label>
            <label className={label}>
              {F.time}
              <input type="time" required value={time} onChange={(e) => setTime(e.target.value)} className={field} />
            </label>
          </div>
          <label className={label}>
            {F.note}
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder={F.notePh} maxLength={200} className={field} />
          </label>
          {people && (
            <label className={label}>
              {F.assignee}
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={field}>
                {[...choices].sort((a, b) => Number(b.user_id === me) - Number(a.user_id === me)).map((p) => (
                  <option key={p.user_id} value={p.user_id}>{who(p)}</option>
                ))}
              </select>
            </label>
          )}
        </section>
        {error && <p role="alert" className="m-0 rounded-[12px] bg-warn-soft px-3 py-2.5 text-[15px] text-warn">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-[#e3e6ec] px-5 py-4 md:px-10">
        <button type="button" onClick={onClose} className="k-btn inline-flex min-h-[52px] items-center rounded-[14px] border-2 border-line px-5 font-medium text-ink">{F.cancel}</button>
        <button type="submit" disabled={saving} className="k-lift flex text-lg disabled:opacity-60">
          <HexCta dark>{saving ? F.saving : F.save}</HexCta>
        </button>
      </div>
    </form>
  );
}
