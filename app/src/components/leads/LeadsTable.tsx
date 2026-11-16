"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AiQuestionPanel, answerText } from "@/components/leads/AiQuestionPanel";
import type { AiQuestion } from "@/lib/ai-questions/types";
import { EmailBadge } from "@/components/leads/EmailBadge";
import { FacetPanel } from "@/components/leads/FacetPanel";
import { NlSearch } from "@/components/leads/NlSearch";
import { SelectionBar, type BulkNotice } from "@/components/leads/SelectionBar";
import { ViewBar } from "@/components/leads/ViewBar";
import type { LeadView } from "@/lib/leads/queries";
import { usd } from "@/components/research/format";
import { activeFilterKeys, DEFAULT_LEAD_FILTERS, filterLeads, leadFacetsOf, type LeadFilters, type SegmentTab } from "@/lib/leads/view";
import { leadsCsvAction } from "@/app/(app)/leads/lead-actions";
import { stageOf } from "@/lib/leads/classify";
import { originText } from "@/lib/leads/table";
import { Pager, usePaged } from "@/components/Pager";
import { LEAD_STAGES, type LeadStage, type LeadTableRow } from "@/lib/leads/types";
import { QualifyControls, RowCheck } from "@/components/qualifier/QualifyControls";
import { useRouter, useSearchParams } from "next/navigation";
import { openedFromList } from "@/components/leads/LeadModal";
import { fill, t } from "@/messages/pt";

const L = t.leads;
const TB = t.leads.toolbar;
const COL = t.leads.columns;
const P = t.leads.paging;
const SEGMENT_TABS: (SegmentTab | "all")[] = ["residential", "small", "large", "none", "all"];
// the archived tab is drawn apart, after "Todos"
const STAGE_TABS: (LeadStage | "all")[] = [...LEAD_STAGES.filter((s) => s !== "archived"), "all"];

const GRID = "md:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.9fr)]";
// the same columns plus the AI question's (Tailwind needs both class names written out)
const GRID_AI = "md:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.6fr)]";

const linkBtn = "inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash";
const tabCls = (on: boolean) => `-mb-px min-h-11 border-b-[3px] px-3 text-[15px] ${on ? "border-blue font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`;
const countCls = "ml-1 bg-ground px-1.5 font-mono text-[13px]";
const menuItem = "flex min-h-11 w-full items-center px-4 text-left text-sm text-ink no-underline hover:bg-ground";

type Panel = "nl" | "ai" | "views" | "qualify";

type Props = {
  items: LeadTableRow[];
  canCreate: boolean;
  sources?: { maps: boolean; apollo: boolean };
  initialFilters?: LeadFilters;
  views?: LeadView[];
  lists?: { id: string; name: string }[];
  /** Showing one list only (/leads?lista=<id>). */
  list?: { id: string; name: string } | null;
  /** AI questions of the workspace (0029) and the worst-case cost of one answer. */
  questions?: AiQuestion[];
  answerReserveUsd?: number;
};

const lastTouch = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/New_York" }) : L.never);

/** The value part of an active-filter chip ("" = the label says it all). */
function chipValue(k: keyof LeadFilters, f: LeadFilters, agents: [string, string][]): string {
  switch (k) {
    case "contact": return L.contactTabs[f.contact];
    case "cities": return f.cities.join(", ");
    case "lists": return f.lists.join(", ");
    case "levels": return f.levels.map((l) => L.facets.levelName[l as 0 | 1 | 2 | 3 | 4]).join(", ");
    case "origins": return f.origins.map((o) => L.facets.origins[o]).join(", ");
    case "emailQuality": return f.emailQuality.map((q) => L.emailQuality.labels[q]).join(", ");
    case "temperature": return f.temperature === "none" ? TB.noResearch : f.temperature === "all" ? "" : t.research.labels.temperature[f.temperature];
    case "agent": return f.agent === "one_off" ? L.oneOff : (agents.find(([id]) => id === f.agent)?.[1] ?? f.agent);
    case "status": return f.status === "all" ? "" : L.statuses[f.status];
    case "tab": return t.research.list.tabs[f.tab];
    case "minLevel": return String(f.minLevel);
    case "companyTypes": return f.companyTypes.map((c) => L.nlSearch.types[c]).join(", ");
    case "minPermitUsd": return usd(f.minPermitUsd);
    case "aiAnswer": return (L.aiQuestion.answers as Record<string, string>)[f.aiAnswer] ?? f.aiAnswer;
    default: return "";
  }
}

/** Typing stays local; the filter (and the whole list) only updates 200 ms after the last keystroke. */
function SearchBox({ value, set }: { value: string; set: (patch: Partial<LeadFilters>) => void }) {
  const [q, setQ] = useState(value);
  useEffect(() => {
    if (q === value) return;
    const id = setTimeout(() => set({ q }), 200);
    return () => clearTimeout(id);
  }, [q, value, set]);
  return (
    <input
      type="search"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      placeholder={L.filters.search}
      aria-label={L.filters.search}
      className="min-h-11 min-w-0 flex-[1_1_160px] border border-line bg-surface px-3 text-sm text-ink"
    />
  );
}

function ContactIcon({ on, glyph, yes, no }: { on: boolean; glyph: string; yes: string; no: string }) {
  return (
    <>
      <span aria-hidden className={on ? "text-blue" : "text-muted opacity-40"}>{glyph}</span>
      <span className="sr-only">{on ? yes : no} </span>
    </>
  );
}

export function LeadsTable({ items, canCreate, sources = { maps: false, apollo: false }, initialFilters = DEFAULT_LEAD_FILTERS, views = [], lists = [], list = null, questions = [], answerReserveUsd = 0 }: Props) {
  const [f, setF] = useState<LeadFilters>(initialFilters);
  // bumped when a saved view replaces every filter, so the search box takes the view's text
  const [searchKey, setSearchKey] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  // the last bulk result (archive / type); kept here because a success unmounts the selection bar
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  const router = useRouter();
  const search = useSearchParams();
  // The lead opens as a modal over this list (?lead=): same page, so filters/pager/scroll stay.
  const leadHref = (id: string) => `?${new URLSearchParams({ ...Object.fromEntries(search), lead: id })}`;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const set = useCallback((patch: Partial<LeadFilters>) => setF((x) => ({ ...x, ...patch })), []);
  const filtered = useMemo(() => filterLeads(items, f), [items, f]);
  const filteredIds = useMemo(() => filtered.map((i) => i.lead.id), [filtered]);
  const selected = useMemo(() => filteredIds.filter((id) => picked.has(id)), [filteredIds, picked]);
  // Paging only slices what is rendered; any filter/size change goes back to page 1.
  const { pageItems, pager } = usePaged(filtered, JSON.stringify(f));
  const pageAllPicked = pageItems.length > 0 && pageItems.every((i) => picked.has(i.lead.id));
  const togglePage = (on: boolean) =>
    setPicked((p) => {
      const n = new Set(p);
      for (const i of pageItems) {
        if (on) n.add(i.lead.id);
        else n.delete(i.lead.id);
      }
      return n;
    });
  const facets = useMemo(() => leadFacetsOf(items, f), [items, f]);
  const activeTotal = useMemo(() => LEAD_STAGES.reduce((n, s) => (s === "archived" ? n : n + facets.stages[s]), 0), [facets]);
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.lead.origin_agent_id && i.agentName) m.set(i.lead.origin_agent_id, i.agentName);
    return [...m.entries()];
  }, [items]);
  const hasOneOff = useMemo(() => items.some((i) => i.lead.origin_kind === "one_off"), [items]);
  const nameById = useMemo(() => new Map(items.map((i) => [i.lead.id, i.display.name])), [items]);
  const cities = useMemo(() => [...new Set(items.map((i) => i.display.city?.trim()).filter((c): c is string => Boolean(c)))], [items]);
  const aiQ = useMemo(() => questions.find((q) => q.id === f.aiQuestion) ?? null, [questions, f.aiQuestion]);
  const chips = activeFilterKeys(f);

  const listBanner = list && (
    <p className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-semibold">{fill(L.inList, { name: list.name })}</span>
      <Link href="/leads" className="text-blue underline underline-offset-4">{L.clearList}</Link>
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
        <p className="text-sm text-muted">{canCreate ? L.empty : L.emptyCloser}</p>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            <Link href="/agentes/novo" className="inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash">
              {L.emptyCta}
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

  const download = async () => {
    setMenuOpen(false);
    setCsvError(null);
    try {
      const res = await leadsCsvAction(filteredIds);
      if ("error" in res) return setCsvError(t.leads.toolbar.csvFailed);
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setCsvError(t.leads.toolbar.csvFailed);
    }
  };
  const openFromMenu = (p: Panel) => {
    setMenuOpen(false);
    setOpenPanel((x) => (x === p ? null : p));
  };
  // the bar sits at the bottom of the screen; the qualifier opens up in the toolbar, so bring it into view
  const openQualifier = () => {
    setOpenPanel("qualify");
    requestAnimationFrame(() => document.getElementById("lead-qualify")?.scrollIntoView({ block: "center" }));
  };
  const clearSelection = () => {
    setPicked(new Set());
    router.refresh();
  };
  const onBulkResult = (n: BulkNotice) => {
    setNotice(n);
    if (n.ok) clearSelection();
  };
  const pickTab = (patch: Partial<LeadFilters>) => {
    setNotice(null);
    set(patch);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {listBanner}
      {canCreate && (
        <div role="group" aria-label={L.segments.label} className="flex flex-wrap border-b border-line">
          {SEGMENT_TABS.map((x) => (
            <button key={x} type="button" aria-pressed={f.segment === x} onClick={() => pickTab({ segment: x })} className={tabCls(f.segment === x)}>
              {L.segments[x]} <span className={countCls}>{facets.segments[x]}</span>
            </button>
          ))}
        </div>
      )}
      <div role="group" aria-label={L.stages.label} className="flex flex-wrap items-stretch border-b border-line">
        {STAGE_TABS.map((x) => (
          <button key={x} type="button" aria-pressed={f.stage === x} onClick={() => pickTab({ stage: x })} className={tabCls(f.stage === x)}>
            {x === "all" ? L.filters.all : L.stages[x]} <span className={countCls}>{x === "all" ? activeTotal : facets.stages[x]}</span>
          </button>
        ))}
        <span aria-hidden className="mx-2 my-2 border-l border-line" />
        <button type="button" aria-pressed={f.stage === "archived"} onClick={() => pickTab({ stage: "archived" })} className={tabCls(f.stage === "archived")}>
          {L.stages.archived} <span className={countCls}>{facets.stages.archived}</span>
        </button>
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <SearchBox key={searchKey} value={f.q} set={set} />
        <button
          type="button"
          aria-expanded={showFilters}
          aria-controls="lead-filters"
          onClick={() => setShowFilters((x) => !x)}
          className="min-h-11 border border-line bg-surface px-4 text-sm font-semibold text-ink hover:border-ink"
        >
          {TB.filters} <span aria-hidden>▾</span>
        </button>
        {canCreate && (
          <div className="relative" onKeyDown={(e) => e.key === "Escape" && setMenuOpen(false)}>
            <button
              type="button"
              aria-label={TB.more}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((x) => !x)}
              className="min-h-11 min-w-11 border border-line bg-surface px-3 text-lg text-ink hover:border-ink"
            >
              <span aria-hidden>⋯</span>
            </button>
            {menuOpen && canCreate && (
              <div role="menu" aria-label={TB.more} className="absolute right-0 z-20 mt-1 flex w-64 max-w-[calc(100vw-2rem)] flex-col border border-line bg-surface py-1">
                <Link href="/leads/subir" role="menuitem" className={menuItem}>{t.imports.button}</Link>
                {sources.maps && <Link href="/leads/buscar#maps" role="menuitem" className={menuItem}>{t.sources.search.maps}</Link>}
                {sources.apollo && <Link href="/leads/buscar#apollo" role="menuitem" className={menuItem}>{t.sources.search.apollo}</Link>}
                <button type="button" role="menuitem" onClick={download} className={menuItem}>{L.csv}</button>
                <button type="button" role="menuitem" onClick={() => openFromMenu("nl")} className={menuItem}>{TB.aiSearch}</button>
                <button type="button" role="menuitem" onClick={() => openFromMenu("ai")} className={menuItem}>{TB.aiQuestion}</button>
                <button type="button" role="menuitem" onClick={() => openFromMenu("views")} className={menuItem}>{TB.views}</button>
                <button type="button" role="menuitem" onClick={() => openFromMenu("qualify")} className={menuItem}>{TB.qualifier}</button>
              </div>
            )}
          </div>
        )}
      </div>
      {csvError && <p role="alert" className="m-0 text-sm text-danger">{csvError}</p>}

      {showFilters && <FacetPanel facets={facets} f={f} set={set} agents={agents} hasOneOff={hasOneOff} />}

      {canCreate && openPanel === "nl" && <NlSearch cities={cities} onApply={(nl) => set(nl)} />}
      {canCreate && openPanel === "ai" && (
        <AiQuestionPanel
          questions={questions}
          f={f}
          set={set}
          selected={selected}
          filtered={filteredIds}
          reserveUsd={answerReserveUsd}
          nameOf={(id) => nameById.get(id) ?? id}
          onDone={() => router.refresh()}
        />
      )}
      {canCreate && openPanel === "views" && (
        <ViewBar
          views={views}
          filters={f}
          onPick={(v) => {
            setF(v ?? initialFilters);
            setSearchKey((k) => k + 1);
          }}
        />
      )}
      {canCreate && openPanel === "qualify" && (
        <div id="lead-qualify">
          <QualifyControls filteredIds={filteredIds} selected={selected} onDone={clearSelection} />
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((k) => {
            const value = chipValue(k, f, agents);
            const label = `${L.chips[k as keyof typeof L.chips]}${value ? `: ${value}` : ""}`;
            return (
              <span key={k} className="inline-flex min-h-9 max-w-full items-center gap-1 border border-blue bg-blue-wash pl-3 text-[13px] text-ink">
                <span className="min-w-0 truncate">{label}</span>
                <button type="button" aria-label={fill(TB.removeChip, { label })} onClick={() => set({ [k]: DEFAULT_LEAD_FILTERS[k] })} className="min-h-9 min-w-9 text-blue hover:bg-blue-soft">
                  <span aria-hidden>×</span>
                </button>
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => set(Object.fromEntries(chips.map((k) => [k, DEFAULT_LEAD_FILTERS[k]])))}
            className="min-h-9 text-sm text-blue underline underline-offset-4"
          >
            {TB.clear}
          </button>
        </div>
      )}

      {notice && <p role="status" className={`m-0 text-sm ${notice.ok ? "text-ok" : "text-danger"}`}>{notice.text}</p>}
      <span className="font-mono text-xs text-muted">{filtered.length} / {items.length}</span>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted">{t.research.list.emptyTab}</p>
      ) : (
        <>
          {canCreate && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={pageAllPicked} onChange={(e) => togglePage(e.target.checked)} className="h-5 w-5" />
              {P.selectPage}
            </label>
          )}
          <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
            {pageItems.map((i) => {
              const hasEmail = Boolean(i.display.email?.trim());
              const hasPhone = Boolean(i.display.phone?.trim());
              return (
                <li key={i.lead.id} className="flex items-stretch border-b border-line last:border-b-0">
                  {canCreate && <RowCheck checked={picked.has(i.lead.id)} name={i.display.name} onChange={(v) => toggle(i.lead.id, v)} />}
                  <Link href={leadHref(i.lead.id)} scroll={false} onClick={() => (openedFromList.value = true)} className={`flex min-w-0 flex-1 flex-col gap-1 px-3.5 py-3 text-ink no-underline hover:bg-ground md:grid ${aiQ ? GRID_AI : GRID} md:items-center md:gap-3`}>
                    <span className="min-w-0">
                      <span className="sr-only">{COL.company}: </span>
                      <span className="block truncate text-sm font-semibold">{i.display.name}</span>
                      {i.display.city && <span className="block truncate text-[13px] text-muted">{i.display.city}</span>}
                      {i.emailQuality && (
                        <span className="mt-0.5 block">
                          <span className="sr-only">{L.facets.emailQuality}: </span>
                          <EmailBadge quality={i.emailQuality} />
                        </span>
                      )}
                    </span>
                    <span className="text-[13px]">
                      <span className="sr-only">{COL.type}: </span>
                      {L.segments[i.segment ?? "none"]}
                    </span>
                    <span className="flex gap-2 text-[15px]">
                      <span className="sr-only">{COL.contact}: </span>
                      <ContactIcon on={hasEmail} glyph="✉" yes={L.contactIcons.email} no={L.contactIcons.noEmail} />
                      <ContactIcon on={hasPhone} glyph="☎" yes={L.contactIcons.phone} no={L.contactIcons.noPhone} />
                    </span>
                    <span className="text-[13px]">
                      <span className="sr-only">{COL.stage}: </span>
                      {L.stages[stageOf(i.lead)]}
                    </span>
                    <span className="truncate text-[13px] text-muted" title={i.origins.length > 0 ? i.origins.map((o) => o.name).join(", ") : undefined}>
                      <span className="sr-only">{COL.origin}: </span>
                      {originText(i)}
                    </span>
                    <span className="font-mono text-[13px] text-muted">
                      <span className="sr-only">{COL.lastContact}: </span>
                      {lastTouch(i.lead.last_touch_at)}
                    </span>
                    {aiQ && (
                      <span className="min-w-0 text-[13px]">
                        <span className="sr-only">{aiQ.question}: </span>
                        <span className="font-semibold">{answerText(i.ai?.[aiQ.id])}</span>
                        {i.ai?.[aiQ.id]?.excerpt && <span className="block truncate text-muted" title={i.ai[aiQ.id].excerpt ?? undefined}>“{i.ai[aiQ.id].excerpt}” · {i.ai[aiQ.id].label}</span>}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <Pager pager={pager} />
        </>
      )}

      {canCreate && selected.length > 0 && (
        <div className="sticky bottom-0 z-10">
          <SelectionBar selected={selected} lists={lists} archivedTab={f.stage === "archived"} onOpenQualifier={openQualifier} onResult={onBulkResult} />
        </div>
      )}
    </div>
  );
}
