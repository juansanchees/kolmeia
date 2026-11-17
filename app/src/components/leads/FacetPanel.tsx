"use client";

import { useEffect, useState } from "react";
import { EMAIL_QUALITIES } from "@/lib/leads/email-quality";
import { ENTERED_PRESETS, fold, LAST_TOUCH_PICKS, originKeyLabel, ROLES, type LeadFacets, type LeadFilters } from "@/lib/leads/view";
import { PANEL_CATEGORIES, pickedIn, type PanelCategory } from "@/lib/leads/filter-ui";
import { fill, ptMessages } from "@/lib/i18n";
import { TEMPERATURES } from "@/lib/research/types";
import { useT } from "@/lib/i18n/client";

const fieldCls = "k-field flex min-h-[52px] items-center gap-2.5 rounded-[14px] border-2 border-line bg-surface px-4";

export function toggle<T>(list: T[], v: T, on: boolean): T[] {
  return on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v);
}

/** One big option row: checkbox or radio, its label and (for checkboxes) the count for the current filters ("—" = none counted). */
function Opt({ type, name, label, n, checked, onChange, i }: { type: "checkbox" | "radio"; name: string; label: string; n?: number | null; checked: boolean; onChange: (on: boolean) => void; i: number }) {
  return (
    <label className={`k-opt flex min-h-[54px] min-w-0 cursor-pointer items-center gap-3.5 rounded-[12px] px-3 ${i < 12 ? "k-in" : ""}`} style={i < 12 ? { animationDelay: `${0.04 + i * 0.03}s` } : undefined}>
      <input type={type} name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-[22px] shrink-0 cursor-pointer" />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      {n !== undefined && <span className="shrink-0 rounded-full bg-cold px-2 py-0.5 font-mono text-sm text-[#4a5361]">{n ?? "—"}</span>}
    </label>
  );
}

/** Typing stays local; the list updates 200 ms after the last keystroke (like the search box). */
function NameBox({ value, set }: { value: string; set: (patch: Partial<LeadFilters>) => void }) {
  const t = useT();
  const P = t.leads.panel;
  const [q, setQ] = useState(value);
  // the chip x or Limpar changes the value from outside: take it into the box
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setQ(value), [value]);
  useEffect(() => {
    if (q === value) return;
    const id = setTimeout(() => set({ nameQ: q }), 200);
    return () => clearTimeout(id);
  }, [q, value, set]);
  return (
    <label className="flex flex-col gap-1.5 font-semibold">
      {P.word}
      <span className={fieldCls}>
        <input type="text" value={q} maxLength={100} placeholder={P.wordPlaceholder} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent font-normal text-ink" />
      </span>
    </label>
  );
}

/**
 * "Mais filtros": categories on the left (badge = options picked), the chosen category's options on the right, each with its
 * count for the current filters (leadFacetsOf). Every filter applies at once. Opens on the first category that has a pick.
 */
export function FacetPanel({ facets, f, set, agents, hasOneOff }: { facets: LeadFacets; f: LeadFilters; set: (patch: Partial<LeadFilters>) => void; agents: [string, string][]; hasOneOff: boolean }) {
  const t = useT();
  const P = t.leads.facets;
  const PN = t.leads.panel;
  const cityN = new Map(facets.cities.map((c) => [c.value, c.n]));
  // a picked city or list outside the counted ones stays visible so it can be unticked
  const cities = [...facets.cities.map((c) => c.value), ...f.cities.filter((c) => !cityN.has(c))];
  const listN = new Map(facets.lists.map((c) => [c.value, c.n]));
  const lists = [...facets.lists.map((c) => c.value), ...f.lists.filter((c) => !listN.has(c))];
  const levelN = new Map(facets.levels.map((c) => [c.value, c.n]));
  const qualityN = new Map(facets.emailQuality.map((c) => [c.value, c.n]));
  const qualities = EMAIL_QUALITIES.filter((q) => qualityN.has(q) || f.emailQuality.includes(q));
  const shown = (Object.keys(PANEL_CATEGORIES) as PanelCategory[]).filter(
    (c) => (c !== "origin" || lists.some((l) => l !== ptMessages.leads.origin.noneOption)) && (c !== "emailQuality" || qualities.length > 0),
  );
  const [cat, setCat] = useState<PanelCategory>(() => shown.find((c) => pickedIn(c, f) > 0) ?? "city");
  const [find, setFind] = useState("");
  const pick = (c: PanelCategory) => {
    setCat(c);
    setFind("");
  };
  const q = fold(find.trim());
  const found = (label: string) => !q || fold(label).includes(q);
  const name = `facet-${cat}`;

  const options = () => {
    switch (cat) {
      case "city":
        return cities.filter(found).map((c, i) => <Opt key={c} type="checkbox" name={name} i={i} label={c} n={cityN.get(c) ?? null} checked={f.cities.includes(c)} onChange={(on) => set({ cities: toggle(f.cities, c, on) })} />);
      case "origin":
        return lists.filter((l) => found(originKeyLabel(l, t))).map((l, i) => (
          <Opt key={l} type="checkbox" name={name} i={i} label={originKeyLabel(l, t)} n={listN.get(l) ?? null} checked={f.lists.includes(l)} onChange={(on) => set({ lists: toggle(f.lists, l, on) })} />
        ));
      case "entered":
        return ENTERED_PRESETS.map((x, i) => <Opt key={x} type="radio" name={name} i={i} label={P.enteredOpts[x]} checked={f.entered === x} onChange={() => set({ entered: x })} />);
      case "lastTouch":
        return LAST_TOUCH_PICKS.map((x, i) => <Opt key={x} type="radio" name={name} i={i} label={P.lastTouchOpts[x]} checked={f.lastTouch === x} onChange={() => set({ lastTouch: x })} />);
      case "name":
        return (
          <>
            <div role="group" aria-label={PN.nameMode} className="inline-flex gap-1 self-start rounded-[14px] bg-cold p-1">
              {([false, true] as const).map((not) => (
                <button key={String(not)} type="button" aria-pressed={f.nameNot === not} onClick={() => set({ nameNot: not })} className={`k-btn min-h-[46px] rounded-[11px] px-[18px] ${f.nameNot === not ? "bg-ink font-semibold text-white" : "bg-transparent text-ink"}`}>
                  {not ? PN.nameHasNot : PN.nameHas}
                </button>
              ))}
            </div>
            <NameBox value={f.nameQ} set={set} />
          </>
        );
      case "role":
        return (
          <>
            {(["all", ...ROLES] as const).map((x, i) => <Opt key={x} type="radio" name={name} i={i} label={P.roleOpts[x]} checked={f.role === x} onChange={() => set({ role: x })} />)}
            <Opt type="checkbox" name="facet-contact-name" i={ROLES.length + 1} label={P.hasContactName} checked={f.hasContactName} onChange={(on) => set({ hasContactName: on })} />
          </>
        );
      case "contact":
        return (
          <>
            <Opt type="checkbox" name={name} i={0} label={P.hasPhone} n={facets.phone} checked={f.hasPhone} onChange={(on) => set({ hasPhone: on })} />
            <Opt type="checkbox" name={name} i={1} label={P.hasEmail} n={facets.email} checked={f.hasEmail} onChange={(on) => set({ hasEmail: on })} />
            <Opt type="checkbox" name={name} i={2} label={P.siteNoEmail} n={facets.siteNoEmail} checked={f.siteNoEmail} onChange={(on) => set({ siteNoEmail: on })} />
          </>
        );
      case "emailQuality":
        return qualities.map((x, i) => (
          <Opt key={x} type="checkbox" name={name} i={i} label={t.leads.emailQuality.labels[x]} n={qualityN.get(x) ?? null} checked={f.emailQuality.includes(x)} onChange={(on) => set({ emailQuality: toggle(f.emailQuality, x, on) })} />
        ));
      case "level":
        return [4, 3, 2, 1, 0].filter((l) => levelN.has(l) || f.levels.includes(l)).map((l, i) => (
          <Opt key={l} type="checkbox" name={name} i={i} label={P.levelName[l as 0 | 1 | 2 | 3 | 4]} n={levelN.get(l) ?? null} checked={f.levels.includes(l)} onChange={(on) => set({ levels: toggle(f.levels, l, on) })} />
        ));
      case "temperature":
        return (["all", ...TEMPERATURES, "none"] as const).map((x, i) => (
          <Opt key={x} type="radio" name={name} i={i} label={x === "all" ? t.leads.filters.all : x === "none" ? t.leads.toolbar.noResearch : t.research.labels.temperature[x]} checked={f.temperature === x} onChange={() => set({ temperature: x })} />
        ));
      case "agent":
        return [["all", t.leads.filters.all] as const, ...(hasOneOff ? [["one_off", t.leads.oneOff] as const] : []), ...agents].map(([id, label], i) => (
          <Opt key={id} type="radio" name={name} i={i} label={label} checked={f.agent === id} onChange={() => set({ agent: id })} />
        ));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
      <nav aria-label={PN.categories} className="grid shrink-0 grid-cols-[repeat(2,minmax(0,1fr))] gap-1 border-b border-[#e3e6ec] bg-ground p-3 md:flex md:w-64 md:flex-col md:overflow-auto md:border-r md:border-b-0 md:py-3.5 md:pl-[26px]">
        {shown.map((c) => {
          const on = c === cat;
          const n = pickedIn(c, f);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              onClick={() => pick(c)}
              className={`k-cat flex min-h-14 min-w-0 items-center gap-2.5 rounded-[14px] px-3.5 text-left text-ink ${on ? "bg-surface font-semibold shadow-[0_1px_2px_rgba(15,27,61,0.06),0_8px_18px_-12px_rgba(15,27,61,0.35)]" : "bg-transparent"}`}
            >
              <span aria-hidden className={`h-6 w-1.5 shrink-0 rounded-full ${on ? "bg-honey" : "bg-transparent"}`} />
              <span className="min-w-0 flex-1 truncate">{PN.labels[c]}</span>
              {n > 0 && (
                <span className="k-pop inline-flex h-[26px] min-w-[26px] shrink-0 items-center justify-center rounded-full bg-honey px-1.5 text-sm font-semibold text-ink">
                  {n}
                  <span className="sr-only"> {fill(PN.picked, { n })}</span>
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <section aria-label={PN.labels[cat]} className="min-w-0 flex-1 md:overflow-auto">
        <div key={cat} className="k-fade flex flex-col gap-3.5 px-5 py-6 md:pl-7 md:pr-10">
          <h3 className="m-0 text-[22px] font-semibold">{PN.labels[cat]}</h3>
          <p className="m-0 text-base text-[#4a5361]">{PN.help[cat]}</p>
          {(cat === "city" || cat === "origin") && (
            <label className={fieldCls}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4A5361" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <span className="sr-only">{PN.find}</span>
              <input type="search" value={find} placeholder={PN.findPlaceholder} onChange={(e) => setFind(e.target.value)} className="min-w-0 flex-1 bg-transparent text-ink" />
            </label>
          )}
          <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
            <legend className="sr-only">{PN.labels[cat]}</legend>
            {options()}
          </fieldset>
        </div>
      </section>
    </div>
  );
}
