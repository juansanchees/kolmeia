"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AddToList } from "@/components/leads/AddToList";
import { FacetPanel } from "@/components/leads/FacetPanel";
import { ViewBar } from "@/components/leads/ViewBar";
import type { LeadView } from "@/lib/leads/queries";
import { DarkChoice } from "@/components/research/controls";
import { UNKNOWN } from "@/components/research/format";
import { TEMPERATURES } from "@/lib/research/types";
import { TABS } from "@/lib/research/sheet";
import { CONTACT_TABS, DEFAULT_LEAD_FILTERS, filterLeads, leadFacetsOf, leadInTab, leadsCsv, originLabel, type LeadFilters, type LeadTab } from "@/lib/leads/view";
import { LEAD_STATUSES, type LeadListItem } from "@/lib/leads/types";
import { LevelBadge } from "@/components/qualifier/LevelBadge";
import { QualifyControls, RowCheck } from "@/components/qualifier/QualifyControls";
import { useRouter } from "next/navigation";
import { fill, t } from "@/messages/pt";

const F = t.leads.filters;
const LB = t.research.labels;
const LEAD_TABS = TABS.filter((x): x is LeadTab => x !== "jobs");
const selectCls = "min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink";

const linkBtn = "inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash";

type Props = {
  items: LeadListItem[];
  canCreate: boolean;
  sources?: { maps: boolean; apollo: boolean };
  initialFilters?: LeadFilters;
  views?: LeadView[];
  lists?: { id: string; name: string }[];
  /** Showing one list only (/leads?lista=<id>). */
  list?: { id: string; name: string } | null;
};

const lastTouch = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/New_York" }) : t.leads.never);

export function LeadsTable({ items, canCreate, sources = { maps: false, apollo: false }, initialFilters = DEFAULT_LEAD_FILTERS, views = [], lists = [], list = null }: Props) {
  const [f, setF] = useState<LeadFilters>(initialFilters);
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const set = (patch: Partial<LeadFilters>) => setF((x) => ({ ...x, ...patch }));
  const filtered = useMemo(() => filterLeads(items, f), [items, f]);
  const facets = useMemo(() => leadFacetsOf(items, f), [items, f]);
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.lead.origin_agent_id && i.agentName) m.set(i.lead.origin_agent_id, i.agentName);
    return [...m.entries()];
  }, [items]);
  const hasOneOff = items.some((i) => i.lead.origin_kind === "one_off");

  const listBanner = list && (
    <p className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-semibold">{fill(t.leads.inList, { name: list.name })}</span>
      <Link href="/leads" className="text-blue underline underline-offset-4">{t.leads.clearList}</Link>
    </p>
  );

  // An empty list is not an empty workspace: say so and offer the way back.
  if (items.length === 0 && list) {
    return (
      <div className="flex flex-col items-start gap-3">
        {listBanner}
        <p className="text-sm text-muted">{t.lists.emptyList}</p>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted">{canCreate ? t.leads.empty : t.leads.emptyCloser}</p>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            <Link href="/agentes/novo" className="inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash">
              {t.leads.emptyCta}
            </Link>
            <Link href="/leads/subir" className="inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash">
              {t.imports.button}
            </Link>
            {sources.maps && <Link href="/leads/buscar#maps" className={linkBtn}>{t.sources.search.maps}</Link>}
            {sources.apollo && <Link href="/leads/buscar#apollo" className={linkBtn}>{t.sources.search.apollo}</Link>}
          </div>
        )}
      </div>
    );
  }

  const download = () => {
    const blob = new Blob([leadsCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewBar views={views} filters={f} onPick={(v) => setF(v ?? initialFilters)} />
      {listBanner}
      <div role="group" aria-label={t.leads.contactTabs.label} className="flex flex-wrap border-b border-line">
        {CONTACT_TABS.map((x) => (
          <button
            key={x}
            type="button"
            aria-pressed={f.contact === x}
            onClick={() => set({ contact: x })}
            className={`-mb-px min-h-11 border-b-[3px] px-4 text-[15px] ${f.contact === x ? "border-blue font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.leads.contactTabs[x]} <span className="ml-1 bg-ground px-1.5 font-mono text-[13px]">{facets.tabs[x]}</span>
          </button>
        ))}
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
      <FacetPanel facets={facets} f={f} set={set} />
      <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder={F.search}
          aria-label={F.search}
          className="min-h-11 min-w-0 flex-[2_1_240px] border border-line bg-surface px-3 text-sm text-ink"
        />
        <select aria-label={F.temperature} value={f.temperature} onChange={(e) => set({ temperature: e.target.value as LeadFilters["temperature"] })} className={`${selectCls} flex-[1_1_140px]`}>
          <option value="all">{F.temperature}: {F.all}</option>
          {TEMPERATURES.map((x) => (
            <option key={x} value={x}>{LB.temperature[x]}</option>
          ))}
        </select>
        <select aria-label={F.agent} value={f.agent} onChange={(e) => set({ agent: e.target.value })} className={`${selectCls} flex-[1_1_140px]`}>
          <option value="all">{F.agent}: {F.all}</option>
          {hasOneOff && <option value="one_off">{t.leads.oneOff}</option>}
          {agents.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select aria-label={F.status} value={f.status} onChange={(e) => set({ status: e.target.value as LeadFilters["status"] })} className={`${selectCls} flex-[1_1_140px]`}>
          <option value="all">{F.status}: {F.all}</option>
          {LEAD_STATUSES.map((x) => (
            <option key={x} value={x}>{t.leads.statuses[x]}</option>
          ))}
        </select>
        <select aria-label={t.qualifier.levelLabel} value={f.minLevel} onChange={(e) => set({ minLevel: Number(e.target.value) as LeadFilters["minLevel"] })} className={`${selectCls} flex-[1_1_140px]`}>
          <option value={0}>{t.qualifier.filterLevelAny}</option>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>{fill(t.qualifier.filterLevel, { n })}</option>
          ))}
        </select>
      </div>

      <div role="group" aria-label={t.research.list.tabsLabel} className="flex flex-wrap gap-2">
        {LEAD_TABS.map((x) => (
          <DarkChoice key={x} pressed={f.tab === x} onClick={() => set({ tab: x })}>
            {t.research.list.tabs[x]} · {items.filter((i) => leadInTab(i, x)).length}
          </DarkChoice>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted">{filtered.length} / {items.length}</span>
        <div className="flex flex-wrap gap-2">
          {canCreate && (
            <Link href="/leads/subir" className="inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash">
              {t.imports.button}
            </Link>
          )}
          {canCreate && sources.maps && <Link href="/leads/buscar#maps" className={linkBtn}>{t.sources.search.maps}</Link>}
          {canCreate && sources.apollo && <Link href="/leads/buscar#apollo" className={linkBtn}>{t.sources.search.apollo}</Link>}
          {canCreate && (
            <button type="button" onClick={download} className="min-h-11 border border-blue bg-surface px-4 text-sm font-semibold text-blue hover:bg-blue-wash">
              {t.leads.csv}
            </button>
          )}
        </div>
      </div>

      {canCreate && <AddToList selected={filtered.filter((i) => picked.has(i.lead.id)).map((i) => i.lead.id)} lists={lists} />}
      {canCreate && (
        <QualifyControls
          filteredIds={filtered.map((i) => i.lead.id)}
          selected={filtered.filter((i) => picked.has(i.lead.id)).map((i) => i.lead.id)}
          onDone={() => {
            setPicked(new Set());
            router.refresh();
          }}
        />
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-muted">{f.contact === "contacted" && facets.tabs.contacted === 0 ? t.leads.contactedEmpty : t.research.list.emptyTab}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {filtered.map((i) => (
            <li key={i.lead.id} className="flex items-stretch border-b border-line last:border-b-0">
              {canCreate && <RowCheck checked={picked.has(i.lead.id)} name={i.display.name} onChange={(v) => toggle(i.lead.id, v)} />}
              <Link href={`/leads/${i.lead.id}`} className="flex min-w-0 flex-1 flex-col gap-1 px-3.5 py-3 text-ink no-underline hover:bg-ground md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,0.6fr)_minmax(0,1.2fr)_minmax(0,0.9fr)] md:items-center md:gap-3">
                <span className="min-w-0">
                  <span className="sr-only">{t.leads.columns.company}: </span>
                  <span className="block truncate text-sm font-semibold">{i.display.name}</span>
                  {i.display.city && <span className="block truncate text-[13px] text-muted">{i.display.city}</span>}
                </span>
                <span className="text-[13px]">
                  <span className="sr-only">{t.leads.columns.level}: </span>
                  <LevelBadge level={i.lead.level} />
                </span>
                <span className="text-[13px]">
                  <span className="sr-only">{t.leads.columns.temperature}: </span>
                  {i.best?.temperature ? LB.temperature[i.best.temperature] : UNKNOWN}
                </span>
                <span className="text-[13px]">
                  <span className="sr-only">{t.leads.columns.approach}: </span>
                  {i.best?.approach ? LB.approach[i.best.approach] : UNKNOWN}
                </span>
                <span className="text-[13px]">
                  <span className="sr-only">{t.leads.columns.status}: </span>
                  {t.leads.statuses[i.lead.status]}
                </span>
                <span className="font-mono text-[13px]">
                  <span className="sr-only">{t.leads.columns.proof}: </span>
                  {i.best ? fill(t.leads.proofCount, { n: i.proofOk }) : t.leads.unproven}
                </span>
                <span className="truncate text-[13px] text-muted">
                  <span className="sr-only">{t.leads.columns.agent}: </span>
                  {originLabel(i)}
                </span>
                <span className="font-mono text-[13px] text-muted">
                  <span className="sr-only">{t.leads.lastTouch}: </span>
                  {lastTouch(i.lead.last_touch_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      </div>
      </div>
    </div>
  );
}
