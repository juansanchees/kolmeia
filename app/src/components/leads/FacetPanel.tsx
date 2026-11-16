"use client";

import { DEFAULT_LEAD_FILTERS, type FacetFilters, type LeadFacets, type LeadOrigin } from "@/lib/leads/view";
import { t } from "@/messages/pt";

const P = t.leads.facets;

function toggle<T>(list: T[], v: T, on: boolean): T[] {
  return on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v);
}

function Check({ label, n, checked, onChange }: { label: string; n: number | null; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="font-mono text-xs text-muted">{n ?? "—"}</span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="m-0 flex flex-col gap-0.5 border-0 border-b border-line p-0 pb-3 last:border-b-0">
      <legend className="mb-1 font-mono text-xs uppercase tracking-wide text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

/** The left panel: each value with its count for the current filters (lead_facets). */
export function FacetPanel({ facets, f, set }: { facets: LeadFacets; f: FacetFilters; set: (patch: Partial<FacetFilters>) => void }) {
  const cityN = new Map(facets.cities.map((c) => [c.value, c.n]));
  // a picked city outside the top list stays visible so it can be unticked
  const cities = [...facets.cities.map((c) => c.value), ...f.cities.filter((c) => !cityN.has(c))];
  const levelN = new Map(facets.levels.map((c) => [c.value, c.n]));
  const originN = new Map(facets.origins.map((c) => [c.value, c.n]));
  const dirty = f.cities.length + f.levels.length + f.origins.length > 0 || f.hasPhone || f.hasEmail;
  return (
    <aside aria-label={P.label} className="flex flex-col gap-3 border border-line bg-surface p-3">
      <Group title={P.city}>
        {cities.map((c) => (
          <Check key={c} label={c} n={cityN.get(c) ?? null} checked={f.cities.includes(c)} onChange={(on) => set({ cities: toggle(f.cities, c, on) })} />
        ))}
      </Group>
      <Group title={P.level}>
        {[4, 3, 2, 1, 0].filter((l) => levelN.has(l) || f.levels.includes(l)).map((l) => (
          <Check key={l} label={P.levelName[l as 0 | 1 | 2 | 3 | 4]} n={levelN.get(l) ?? null} checked={f.levels.includes(l)} onChange={(on) => set({ levels: toggle(f.levels, l, on) })} />
        ))}
      </Group>
      <Group title={P.contact}>
        <Check label={P.hasPhone} n={facets.phone} checked={f.hasPhone} onChange={(on) => set({ hasPhone: on })} />
        <Check label={P.hasEmail} n={facets.email} checked={f.hasEmail} onChange={(on) => set({ hasEmail: on })} />
      </Group>
      <Group title={P.origin}>
        {(["import", "agent", "one_off"] as LeadOrigin[]).filter((o) => originN.has(o) || f.origins.includes(o)).map((o) => (
          <Check key={o} label={P.origins[o]} n={originN.get(o) ?? null} checked={f.origins.includes(o)} onChange={(on) => set({ origins: toggle(f.origins, o, on) })} />
        ))}
      </Group>
      {dirty && (
        <button
          type="button"
          onClick={() => set({ cities: [], levels: [], origins: [], hasPhone: DEFAULT_LEAD_FILTERS.hasPhone, hasEmail: DEFAULT_LEAD_FILTERS.hasEmail })}
          className="min-h-11 self-start text-sm text-blue underline underline-offset-4"
        >
          {P.clear}
        </button>
      )}
    </aside>
  );
}
