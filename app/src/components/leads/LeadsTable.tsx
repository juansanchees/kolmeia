"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DarkChoice } from "@/components/research/controls";
import { UNKNOWN } from "@/components/research/format";
import { TEMPERATURES } from "@/lib/research/types";
import { TABS } from "@/lib/research/sheet";
import { DEFAULT_LEAD_FILTERS, filterLeads, leadInTab, leadsCsv, originLabel, type LeadFilters, type LeadTab } from "@/lib/leads/view";
import { LEAD_STATUSES, type LeadListItem } from "@/lib/leads/types";
import { LevelBadge } from "@/components/qualifier/LevelBadge";
import { fill, t } from "@/messages/pt";

const F = t.leads.filters;
const LB = t.research.labels;
const LEAD_TABS = TABS.filter((x): x is LeadTab => x !== "jobs");
const selectCls = "min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink";

const linkBtn = "inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash";

export function LeadsTable({ items, canCreate, sources = { maps: false, apollo: false } }: { items: LeadListItem[]; canCreate: boolean; sources?: { maps: boolean; apollo: boolean } }) {
  const [f, setF] = useState<LeadFilters>(DEFAULT_LEAD_FILTERS);
  const set = (patch: Partial<LeadFilters>) => setF((x) => ({ ...x, ...patch }));
  const filtered = useMemo(() => filterLeads(items, f), [items, f]);
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.lead.origin_agent_id && i.agentName) m.set(i.lead.origin_agent_id, i.agentName);
    return [...m.entries()];
  }, [items]);
  const hasOneOff = items.some((i) => i.lead.origin_kind === "one_off");

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
          <button type="button" onClick={download} className="min-h-11 border border-blue bg-surface px-4 text-sm font-semibold text-blue hover:bg-blue-wash">
            {t.leads.csv}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted">{t.research.list.emptyTab}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {filtered.map((i) => (
            <li key={i.lead.id} className="border-b border-line last:border-b-0">
              <Link href={`/leads/${i.lead.id}`} className="flex min-w-0 flex-col gap-1 px-3.5 py-3 text-ink no-underline hover:bg-ground md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,0.6fr)_minmax(0,1.2fr)] md:items-center md:gap-3">
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
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
