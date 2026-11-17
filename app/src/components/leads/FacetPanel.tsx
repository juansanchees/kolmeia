"use client";

import { useEffect, useState } from "react";
import { EMAIL_QUALITIES } from "@/lib/leads/email-quality";
import { ENTERED_PRESETS, LAST_TOUCH_PICKS, originKeyLabel, ROLES, type LeadFacets, type LeadFilters } from "@/lib/leads/view";
import { ptMessages } from "@/lib/i18n";
import { TEMPERATURES } from "@/lib/research/types";
import { useT } from "@/lib/i18n/client";

const selectCls = "min-h-11 w-full min-w-0 border border-line bg-surface px-2.5 text-sm text-ink";

export function toggle<T>(list: T[], v: T, on: boolean): T[] {
  return on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v);
}

function Check({ label, n, checked, onChange }: { label: string; n: number | null; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-9 min-w-0 items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      <span className="shrink-0 text-right font-mono text-xs text-muted">{n ?? "—"}</span>
    </label>
  );
}

/** Typing stays local; the list updates 200 ms after the last keystroke (like the search box). */
function NameBox({ value, set }: { value: string; set: (patch: Partial<LeadFilters>) => void }) {
  const t = useT();
  const P = t.leads.facets;
  const [q, setQ] = useState(value);
  // the chip x or Limpar changes the value from outside: take it into the box
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setQ(value), [value]);
  useEffect(() => {
    if (q === value) return;
    const id = setTimeout(() => set({ nameQ: q }), 200);
    return () => clearTimeout(id);
  }, [q, value, set]);
  return <input type="text" aria-label={P.nameQ} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} className={selectCls} />;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-0.5 border-0 border-b border-line p-0 pb-3 last:border-b-0">
      <legend className="mb-1 font-mono text-xs uppercase tracking-wide text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

/** The "Filtros" panel: each value with its count for the current filters (leadFacetsOf), plus temperature and agent. */
export function FacetPanel({ facets, f, set, agents, hasOneOff }: { facets: LeadFacets; f: LeadFilters; set: (patch: Partial<LeadFilters>) => void; agents: [string, string][]; hasOneOff: boolean }) {
  const t = useT();
  const P = t.leads.facets;
  const F = t.leads.filters;
  const cityN = new Map(facets.cities.map((c) => [c.value, c.n]));
  // a picked city or list outside the counted ones stays visible so it can be unticked
  const cities = [...facets.cities.map((c) => c.value), ...f.cities.filter((c) => !cityN.has(c))];
  const listN = new Map(facets.lists.map((c) => [c.value, c.n]));
  const lists = [...facets.lists.map((c) => c.value), ...f.lists.filter((c) => !listN.has(c))];
  const levelN = new Map(facets.levels.map((c) => [c.value, c.n]));
  const qualityN = new Map(facets.emailQuality.map((c) => [c.value, c.n]));
  const qualities = EMAIL_QUALITIES.filter((q) => qualityN.has(q) || f.emailQuality.includes(q));
  return (
    <aside id="lead-filters" aria-label={P.label} className="grid gap-3 border border-line bg-surface p-3 grid-cols-[minmax(0,1fr)] md:grid-cols-[repeat(3,minmax(0,1fr))]">
      <Group title={P.city}>
        {cities.map((c) => (
          <Check key={c} label={c} n={cityN.get(c) ?? null} checked={f.cities.includes(c)} onChange={(on) => set({ cities: toggle(f.cities, c, on) })} />
        ))}
      </Group>
      {lists.some((l) => l !== ptMessages.leads.origin.noneOption) && (
        <Group title={t.leads.origin.filter}>
          {lists.map((l) => (
            <Check key={l} label={originKeyLabel(l, t)} n={listN.get(l) ?? null} checked={f.lists.includes(l)} onChange={(on) => set({ lists: toggle(f.lists, l, on) })} />
          ))}
        </Group>
      )}
      <Group title={P.entered}>
        <select aria-label={P.entered} value={f.entered} onChange={(e) => set({ entered: e.target.value as LeadFilters["entered"] })} className={selectCls}>
          {ENTERED_PRESETS.map((x) => <option key={x} value={x}>{P.enteredOpts[x]}</option>)}
        </select>
      </Group>
      <Group title={P.lastTouch}>
        <select aria-label={P.lastTouch} value={f.lastTouch} onChange={(e) => set({ lastTouch: e.target.value as LeadFilters["lastTouch"] })} className={selectCls}>
          {LAST_TOUCH_PICKS.map((x) => <option key={x} value={x}>{P.lastTouchOpts[x]}</option>)}
        </select>
      </Group>
      <Group title={P.nameQ}>
        <select aria-label={P.nameQ} value={f.nameNot ? "not" : "yes"} onChange={(e) => set({ nameNot: e.target.value === "not" })} className={selectCls}>
          <option value="yes">{P.nameContains}</option>
          <option value="not">{P.nameNotContains}</option>
        </select>
        <NameBox value={f.nameQ} set={set} />
      </Group>
      <Group title={P.role}>
        <select aria-label={P.role} value={f.role} onChange={(e) => set({ role: e.target.value as LeadFilters["role"] })} className={selectCls}>
          {(["all", ...ROLES] as const).map((x) => <option key={x} value={x}>{P.roleOpts[x]}</option>)}
        </select>
        <Check label={P.hasContactName} n={null} checked={f.hasContactName} onChange={(on) => set({ hasContactName: on })} />
      </Group>
      <Group title={P.contact}>
        <Check label={P.hasEmail} n={facets.email} checked={f.hasEmail} onChange={(on) => set({ hasEmail: on })} />
        <Check label={P.siteNoEmail} n={facets.siteNoEmail} checked={f.siteNoEmail} onChange={(on) => set({ siteNoEmail: on })} />
        <Check label={P.hasPhone} n={facets.phone} checked={f.hasPhone} onChange={(on) => set({ hasPhone: on })} />
      </Group>
      {qualities.length > 0 && (
        <Group title={P.emailQuality}>
          {qualities.map((q) => (
            <Check key={q} label={t.leads.emailQuality.labels[q]} n={qualityN.get(q) ?? null} checked={f.emailQuality.includes(q)} onChange={(on) => set({ emailQuality: toggle(f.emailQuality, q, on) })} />
          ))}
        </Group>
      )}
      <Group title={P.level}>
        {[4, 3, 2, 1, 0].filter((l) => levelN.has(l) || f.levels.includes(l)).map((l) => (
          <Check key={l} label={P.levelName[l as 0 | 1 | 2 | 3 | 4]} n={levelN.get(l) ?? null} checked={f.levels.includes(l)} onChange={(on) => set({ levels: toggle(f.levels, l, on) })} />
        ))}
      </Group>
      <Group title={F.temperature}>
        <select aria-label={F.temperature} value={f.temperature} onChange={(e) => set({ temperature: e.target.value as LeadFilters["temperature"] })} className={selectCls}>
          <option value="all">{F.all}</option>
          {TEMPERATURES.map((x) => (
            <option key={x} value={x}>{t.research.labels.temperature[x]}</option>
          ))}
          <option value="none">{t.leads.toolbar.noResearch}</option>
        </select>
      </Group>
      <Group title={F.agent}>
        <select aria-label={F.agent} value={f.agent} onChange={(e) => set({ agent: e.target.value })} className={selectCls}>
          <option value="all">{F.all}</option>
          {hasOneOff && <option value="one_off">{t.leads.oneOff}</option>}
          {agents.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </Group>
    </aside>
  );
}
