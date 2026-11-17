"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { btn } from "@/components/email/bits";
import { DarkChoice } from "@/components/research/controls";
import { saveHomeRuleAction } from "@/app/(app)/inicio/actions";
import { DEFAULT_HOME_RULE, HOME_MIN_TEMPS, HOME_ORDERS, HOME_SEGMENTS, homeMatches, type HomeRow, type HomeRule } from "@/lib/home/rule";
import { ROLES } from "@/lib/leads/view";
import { fill, t } from "@/messages/pt";

const E = t.home.editor;
const field = "flex flex-col gap-1 text-sm";
const select = "min-h-11 border border-edge bg-surface px-2 text-[15px] text-ink";

/** "Editar regra": the panel of the Regra mockup. The preview counts with the same pure matcher the list uses. */
export function RuleEditor({ rule, rows, cities, origins }: { rule: HomeRule; rows: HomeRow[]; cities: string[]; origins: string[] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<HomeRule>(rule);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<HomeRule>) => setDraft((d) => ({ ...d, ...patch }));
  const n = useMemo(() => (open ? homeMatches(rows, draft).length : 0), [open, rows, draft]);
  const withCurrent = (list: string[], v: string) => (v && !list.includes(v) ? [v, ...list] : list);

  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  const show = () => {
    setDraft(rule);
    setError(null);
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  const save = () =>
    startSave(async () => {
      const r = await saveHomeRuleAction(draft);
      if (!r.ok) return setError(r.message ?? E.failed);
      close();
    });

  return (
    <>
      <button ref={opener} type="button" onClick={show} className={`${btn.ghost} min-h-10 text-sm`}>
        {t.home.first.edit}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-rule-title"
            tabIndex={-1}
            onKeyDown={(e) => e.key === "Escape" && close()}
            className="relative flex max-h-[92vh] w-full max-w-[640px] flex-col gap-5 overflow-y-auto border border-line bg-ground p-5 pt-12 outline-none"
          >
            <button type="button" aria-label={E.close} onClick={close} className="absolute right-2 top-2 inline-flex size-9 items-center justify-center border border-line bg-surface text-lg leading-none">
              ×
            </button>
            <div>
              <h2 id="home-rule-title" className="text-3xl uppercase">{E.title}</h2>
              <p className="mt-1 text-sm text-muted">{E.intro}</p>
            </div>

            <section className="flex flex-col gap-4 border border-line bg-surface p-4">
              <h3 className="font-mono text-sm font-medium uppercase tracking-wide text-muted">{E.who}</h3>
              <div role="group" aria-label={E.type} className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">{E.type}</span>
                <div className="flex flex-wrap gap-2">
                  {HOME_SEGMENTS.map((s) => (
                    <DarkChoice key={s} pressed={draft.segments.includes(s)} onClick={() => set({ segments: draft.segments.includes(s) ? draft.segments.filter((x) => x !== s) : [...draft.segments, s] })}>
                      {t.leads.segments[s]}
                    </DarkChoice>
                  ))}
                </div>
              </div>
              <fieldset className="flex flex-col gap-1.5 border-0 p-0">
                <legend className="text-sm font-semibold">{E.contact}</legend>
                {(
                  [["hasPhone", t.leads.facets.hasPhone], ["hasEmail", t.leads.facets.hasEmail], ["hasContactName", t.leads.facets.hasContactName]] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex min-h-9 items-center gap-2 text-[15px]">
                    <input type="checkbox" checked={draft[k]} onChange={(e) => set({ [k]: e.target.checked })} className="size-5 accent-blue" />
                    {label}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={field}>
                  {E.city}
                  <select value={draft.city} onChange={(e) => set({ city: e.target.value })} className={select}>
                    <option value="">{E.any}</option>
                    {withCurrent(cities, draft.city).map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className={field}>
                  {E.origin}
                  <select value={draft.origin} onChange={(e) => set({ origin: e.target.value })} className={select}>
                    <option value="">{E.any}</option>
                    {withCurrent(origins, draft.origin).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
                <label className={field}>
                  {E.temperature}
                  <select value={draft.minTemperature} onChange={(e) => set({ minTemperature: e.target.value as HomeRule["minTemperature"] })} className={select}>
                    {HOME_MIN_TEMPS.map((v) => <option key={v} value={v}>{t.home.rule.temps[v]}</option>)}
                  </select>
                </label>
                <label className={field}>
                  {E.role}
                  <select value={draft.role} onChange={(e) => set({ role: e.target.value as HomeRule["role"] })} className={select}>
                    {(["all", ...ROLES] as const).map((v) => <option key={v} value={v}>{t.leads.facets.roleOpts[v]}</option>)}
                  </select>
                </label>
              </div>
              <p className="text-[13px] text-muted">{E.always}</p>
            </section>

            <section className="flex flex-col gap-2 border border-line bg-surface p-4">
              <h3 className="font-mono text-sm font-medium uppercase tracking-wide text-muted">{E.order}</h3>
              <fieldset className="flex flex-col gap-1 border-0 p-0">
                <legend className="sr-only">{E.order}</legend>
                {HOME_ORDERS.map((o) => (
                  <label key={o} className="flex min-h-9 items-center gap-2 text-[15px]">
                    <input type="radio" name="home-order" checked={draft.order === o} onChange={() => set({ order: o })} className="size-5 accent-blue" />
                    <span>
                      <b className="font-semibold">{t.home.rule.orderLabels[o]}</b>
                      {o === "recommended" && <span className="text-sm text-muted"> · {t.home.rule.orderHint}</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            </section>

            <section className="flex flex-col gap-1 border border-line bg-surface p-4">
              <h3 className="font-mono text-sm font-medium uppercase tracking-wide text-muted">{E.howMany}</h3>
              <p className="text-[15px]">{E.howManyText}</p>
            </section>

            <p role="status" className="bg-blue-wash px-3 py-2.5 text-[15px] text-blue-ink">
              {n === 1 ? E.previewOne : fill(E.preview, { n: n.toLocaleString("pt-BR") })}
            </p>
            {error && <p role="alert" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">{error}</p>}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button type="button" onClick={() => setDraft(DEFAULT_HOME_RULE)} className={btn.link}>{E.reset}</button>
              <div className="flex gap-2">
                <button type="button" onClick={close} className={btn.ghost}>{E.cancel}</button>
                <button type="button" onClick={save} disabled={saving} className={btn.primary}>{saving ? E.saving : E.save}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
