"use client";

import { useMemo, useState, useTransition } from "react";
import { saveDayPlanAction } from "@/app/(app)/inicio/actions";
import {
  buildPlan,
  COUNT_MAX,
  COUNT_MIN,
  DEFAULT_PLAN,
  moveBlock,
  NO_ANSWER_MAX,
  NO_ANSWER_MIN,
  type BlockId,
  type DayPlan,
  type PlanInput,
} from "@/lib/home/plan";
import { DEFAULT_HOME_RULE, HOME_MIN_TEMPS, HOME_ORDERS, HOME_SEGMENTS, type HomeRule } from "@/lib/home/rule";
import { originKeyLabel, ROLES } from "@/lib/leads/view";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { Chip, HexCta, ICON, Icon, PanelHead, SidePanel, Stepper } from "./bits";

const h3 = "m-0 font-body text-base font-semibold";
const opt = "k-opt flex min-h-[50px] cursor-pointer items-center gap-3.5 rounded-[12px] px-3";
const box = "size-[22px] shrink-0 cursor-pointer";
const select = "k-field min-h-12 rounded-[12px] border-2 border-line bg-surface px-2.5 text-base text-ink";

/** "Montar meu dia": the blocks in order on the left, the chosen block's settings on the right, a live preview. */
export function PlanConfig(props: {
  open: boolean;
  start: BlockId;
  onClose: () => void;
  onSaved: (plan: DayPlan, rule: HomeRule) => void;
  input: PlanInput;
  plan: DayPlan;
  rule: HomeRule;
  cities: string[];
  origins: string[];
}) {
  const t = useT();
  const C = t.home.config;
  return (
    <SidePanel open={props.open} onClose={props.onClose} labelledBy="plan-config-title">
      <PanelHead id="plan-config-title" title={C.title} intro={C.intro} close={C.close} onClose={props.onClose} />
      {/* remount per opening: the draft starts from what is saved */}
      <Body key={props.start} {...props} />
    </SidePanel>
  );
}

function Body({ start, onClose, onSaved, input, plan, rule, cities, origins }: Parameters<typeof PlanConfig>[0]) {
  const t = useT();
  const C = t.home.config;
  const [cat, setCat] = useState<BlockId>(start);
  const [draft, setDraft] = useState<DayPlan>(plan);
  const [r, setR] = useState<HomeRule>(rule);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const built = useMemo(() => buildPlan(input, draft, r), [input, draft, r]);
  const available = built.blocks.find((b) => b.id === cat)?.available ?? 0;
  const set = (patch: Partial<DayPlan>) => setDraft((d) => ({ ...d, ...patch }));
  const setRule = (patch: Partial<HomeRule>) => setR((x) => ({ ...x, ...patch }));
  const shown = !draft.hidden.includes(cat);
  const title = (id: BlockId) => t.home.plan.blocks[id].title;
  const withCurrent = (list: string[], v: string) => (v && !list.includes(v) ? [v, ...list] : list);
  const check = (on: boolean, onChange: (v: boolean) => void, label: string, hint = "", type: "checkbox" | "radio" = "checkbox", name?: string) => (
    <label key={label} className={opt}>
      <input type={type} name={name} checked={on} onChange={(e) => onChange(type === "radio" ? true : e.target.checked)} className={box} />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-sm text-[#4a5361]">{hint}</span>}
    </label>
  );
  const group = (label: string, children: React.ReactNode, asFieldset = true) =>
    asFieldset ? (
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className={`${h3} mb-2`}>{label}</legend>
        {children}
      </fieldset>
    ) : (
      <div role="group" aria-label={label} className="flex flex-col gap-2">
        <h3 className={h3}>{label}</h3>
        {children}
      </div>
    );
  const segs = (list: readonly string[], toggle: (s: (typeof HOME_SEGMENTS)[number]) => void) => (
    <div className="flex flex-wrap gap-2">
      {HOME_SEGMENTS.map((s) => (
        <Chip key={s} on={list.includes(s)} onClick={() => toggle(s)}>{t.leads.segments[s]}</Chip>
      ))}
    </div>
  );
  const flip = <T,>(list: readonly T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = () =>
    startSave(async () => {
      const res = await saveDayPlanAction({ plan: draft, rule: r });
      if (!res.ok) return setError(res.message ?? C.failed);
      onSaved(draft, r);
      onClose();
    });

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <nav aria-label={C.order} className="flex shrink-0 flex-col gap-1.5 border-b border-[#e3e6ec] bg-ground py-4 pl-5 pr-3 md:w-[300px] md:overflow-y-auto md:border-b-0 md:border-r md:pl-[26px]">
          <span className="px-1.5 pb-1.5 font-mono text-[13px] tracking-[0.06em] text-[#4a5361]">{C.order}</span>
          {draft.order.map((id, i) => {
            const on = cat === id;
            const hidden = draft.hidden.includes(id);
            const arrow = "k-btn inline-flex h-11 w-10 items-center justify-center rounded-[10px] text-ink disabled:opacity-30";
            return (
              <div key={id} className={`flex items-center gap-1 rounded-[14px] ${on ? "bg-surface shadow-[0_1px_2px_rgba(15,27,61,0.06),0_8px_18px_-12px_rgba(15,27,61,0.35)]" : ""}`}>
                <button type="button" aria-pressed={on} onClick={() => setCat(id)} className="k-cat flex min-h-[60px] min-w-0 flex-1 items-center gap-2.5 rounded-[14px] pl-2.5 pr-1.5 text-left text-ink">
                  <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden className="shrink-0">
                    <path className={hidden ? "fill-line stroke-line" : "fill-honey stroke-honey"} strokeWidth="1.6" strokeLinejoin="round" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
                    <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" className="fill-ink">{i + 1}</text>
                  </svg>
                  <span className="flex min-w-0 flex-col">
                    <span className={on ? "font-semibold" : "font-medium"}>{title(id)}</span>
                    <span className="text-sm text-[#4a5361]">{hidden ? C.hidden : fill(C.perDay, { n: draft.counts[id] })}</span>
                  </span>
                </button>
                <button type="button" aria-label={fill(t.home.plan.up, { name: title(id) })} disabled={i === 0} onClick={() => set({ order: moveBlock(draft.order, id, -1) })} className={arrow}>
                  <Icon d={ICON.up} w={2.4} />
                </button>
                <button type="button" aria-label={fill(t.home.plan.down, { name: title(id) })} disabled={i === draft.order.length - 1} onClick={() => set({ order: moveBlock(draft.order, id, 1) })} className={`${arrow} mr-1`}>
                  <Icon d={ICON.down} w={2.4} />
                </button>
              </div>
            );
          })}
          <p className="m-0 mt-2.5 px-1.5 text-sm text-[#4a5361]">{C.orderHint}</p>
        </nav>

        <section key={cat} aria-labelledby="plan-config-cat" className="k-fade flex min-w-0 flex-1 flex-col gap-5 px-5 py-5 md:overflow-y-auto md:pl-7 md:pr-10">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="plan-config-cat" className="m-0 font-body text-[23px] font-semibold">{title(cat)}</h3>
              <p className="m-0 mt-1 text-base text-[#4a5361]">{C.help[cat]}</p>
            </div>
            <button type="button" role="switch" aria-checked={shown} aria-label={C.showLabel} onClick={() => set({ hidden: shown ? [...draft.hidden, cat] : draft.hidden.filter((x) => x !== cat) })} className="k-btn inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-[12px] px-1 text-[15px] text-ink">
              <span className={`inline-flex h-7 w-12 items-center rounded-full p-[3px] ${shown ? "bg-ink" : "bg-[#8a93a6]"}`}>
                <span className={`size-[22px] rounded-full bg-white shadow transition-transform ${shown ? "translate-x-5" : ""}`} />
              </span>
              {shown ? C.shown : C.hiddenSwitch}
            </button>
          </div>

          {cat === "returns" && (
            <>
              {group(C.returns.which, (
                <>
                  {check(draft.returns.late, (v) => set({ returns: { ...draft.returns, late: v } }), C.returns.late, C.returns.lateHint)}
                  {check(draft.returns.today, (v) => set({ returns: { ...draft.returns, today: v } }), C.returns.today)}
                  {check(draft.returns.tomorrow, (v) => set({ returns: { ...draft.returns, tomorrow: v } }), C.returns.tomorrow, C.returns.tomorrowHint)}
                </>
              ))}
              {/* the closer only sees her own: no "team" choice */}
              {input.sender && group(C.returns.who, (
                <>
                  {check(!draft.returns.team, () => set({ returns: { ...draft.returns, team: false } }), C.returns.mine, "", "radio", "ret-who")}
                  {check(draft.returns.team, () => set({ returns: { ...draft.returns, team: true } }), C.returns.team, "", "radio", "ret-who")}
                </>
              ))}
            </>
          )}

          {cat === "call" && (
            <>
              {group(C.call.size, segs(r.segments, (s) => setRule({ segments: flip(r.segments, s) })), false)}
              {group(C.call.contact, (
                <>
                  {check(r.hasPhone, (v) => setRule({ hasPhone: v }), t.leads.facets.hasPhone)}
                  {check(r.hasContactName, (v) => setRule({ hasContactName: v }), t.leads.facets.hasContactName)}
                  {check(r.hasEmail, (v) => setRule({ hasEmail: v }), t.leads.facets.hasEmail)}
                </>
              ))}
              {group(C.call.contacted, <p className="m-0 rounded-[12px] bg-ground px-3 py-2.5 text-[15px] text-[#4a5361]"><b className="font-semibold text-ink">{C.call.never}.</b> {t.home.editor.always}</p>, false)}
              {group(C.call.more, (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[15px] text-[#4a5361]">
                    {t.home.editor.city}
                    <select value={r.city} onChange={(e) => setRule({ city: e.target.value })} className={select}>
                      <option value="">{t.home.editor.any}</option>
                      {withCurrent(cities, r.city).map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[15px] text-[#4a5361]">
                    {t.home.editor.origin}
                    <select value={r.origin} onChange={(e) => setRule({ origin: e.target.value })} className={select}>
                      <option value="">{t.home.editor.any}</option>
                      {withCurrent(origins, r.origin).map((o) => <option key={o} value={o}>{originKeyLabel(o, t)}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[15px] text-[#4a5361]">
                    {t.home.editor.temperature}
                    <select value={r.minTemperature} onChange={(e) => setRule({ minTemperature: e.target.value as HomeRule["minTemperature"] })} className={select}>
                      {HOME_MIN_TEMPS.map((v) => <option key={v} value={v}>{t.home.rule.temps[v]}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[15px] text-[#4a5361]">
                    {t.home.editor.role}
                    <select value={r.role} onChange={(e) => setRule({ role: e.target.value as HomeRule["role"] })} className={select}>
                      {(["all", ...ROLES] as const).map((v) => <option key={v} value={v}>{t.leads.facets.roleOpts[v]}</option>)}
                    </select>
                  </label>
                </div>
              ), false)}
              {group(C.call.order, HOME_ORDERS.map((o) => check(r.order === o, () => setRule({ order: o }), t.home.rule.orderLabels[o], o === "recommended" ? t.home.rule.orderHint : "", "radio", "call-order")))}
            </>
          )}

          {cat === "email" && (
            <>
              {group(C.email.who, (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-[220px] flex-1">{check(draft.email.noAnswer, (v) => set({ email: { ...draft.email, noAnswer: v } }), C.email.noAnswer)}</div>
                    <label className="flex items-center gap-2 text-[15px] text-[#4a5361]">
                      <span className="sr-only">{C.email.times}</span>
                      <select value={draft.email.noAnswerN} onChange={(e) => set({ email: { ...draft.email, noAnswerN: Number(e.target.value) } })} className={select}>
                        {Array.from({ length: NO_ANSWER_MAX - NO_ANSWER_MIN + 1 }, (_, i) => NO_ANSWER_MIN + i).map((n) => <option key={n} value={n}>{fill(C.email.timesOpt, { n })}</option>)}
                      </select>
                    </label>
                  </div>
                  {check(draft.email.noPhone, (v) => set({ email: { ...draft.email, noPhone: v } }), C.email.noPhone)}
                  {check(draft.email.silent, (v) => set({ email: { ...draft.email, silent: v } }), C.email.silent, C.email.silentHint)}
                  <p className="m-0 px-3 text-sm text-[#4a5361]">{C.email.always}</p>
                </>
              ))}
              {group(C.email.size, (
                <>
                  {segs(draft.email.segments, (s) => set({ email: { ...draft.email, segments: flip(draft.email.segments, s) } }))}
                  <p className="m-0 text-sm text-[#4a5361]">{C.email.sizeHint}</p>
                </>
              ), false)}
            </>
          )}

          {cat === "review" && group(C.review.what, (
            <>
              {(["meetingNoDate", "newYesterday", "bigNoContact", "noType"] as const).map((k) =>
                check(draft.review[k], (v) => set({ review: { ...draft.review, [k]: v } }), C.review[k], k === "noType" ? C.review.noTypeHint : ""),
              )}
            </>
          ))}

          {group(C.howMany, (
            <>
              <Stepper value={draft.counts[cat]} min={COUNT_MIN} max={COUNT_MAX} onChange={(n) => set({ counts: { ...draft.counts, [cat]: n } })} less={C.less} more={C.more} />
              <span className="text-sm text-[#4a5361]">{C.howManyHint}</span>
            </>
          ), false)}

          <p role="status" className="m-0 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3.5 text-base">
            {available === 1 ? C.previewOne : fill(C.preview, { n: available.toLocaleString(t.intl) })}
          </p>
          {error && <p role="alert" className="m-0 rounded-[12px] bg-warn-soft px-3 py-2.5 text-[15px] text-warn">{error}</p>}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e3e6ec] bg-surface px-5 py-4 md:px-10">
        <button type="button" onClick={() => { setDraft(DEFAULT_PLAN); setR(DEFAULT_HOME_RULE); }} className="k-btn k-link min-h-12 rounded-[12px] px-3.5 font-semibold underline">
          {C.reset}
        </button>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={onClose} className="k-btn inline-flex min-h-[52px] items-center rounded-[14px] border-2 border-line px-5 font-medium text-ink">{C.cancel}</button>
          <button type="button" onClick={save} disabled={saving} className="k-lift flex text-lg disabled:opacity-60">
            <HexCta dark>{saving ? C.saving : C.save}</HexCta>
          </button>
        </div>
      </div>
    </>
  );
}

