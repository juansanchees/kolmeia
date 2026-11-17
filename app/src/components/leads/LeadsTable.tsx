"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AiQuestionPanel, answerText } from "@/components/leads/AiQuestionPanel";
import type { AiQuestion } from "@/lib/ai-questions/types";
import { EmailBadge } from "@/components/leads/EmailBadge";
import { FacetPanel } from "@/components/leads/FacetPanel";
import { FilterDialog } from "@/components/leads/FilterDialog";
import { Chevron, HexIcon } from "@/components/leads/hex";
import { NlSearch } from "@/components/leads/NlSearch";
import { SelectionBar, type BulkNotice } from "@/components/leads/SelectionBar";
import { ViewBar } from "@/components/leads/ViewBar";
import type { LeadView } from "@/lib/leads/queries";
import { usd } from "@/components/research/format";
import { clearPatch, DEFAULT_LEAD_FILTERS, filterLeads, hasSiteNoEmail, leadFacetsOf, sortRows, type LeadFilters, type SegmentTab, type Sort, type SortKey } from "@/lib/leads/view";
import { chipValue, clearAllPatch, countOf, panelFilterKeys, removableChipKeys, SHORTCUT_CHIPS, summaryOf } from "@/lib/leads/filter-ui";
import { leadsCsvAction } from "@/app/(app)/leads/lead-actions";
import { AI_TYPE_BATCH, AI_TYPE_MAX, stageOf } from "@/lib/leads/classify";
import { classifyTypesAction } from "@/app/(app)/leads/lead-type-actions";
import { findEmailAction } from "@/app/(app)/leads/email-actions";
import { summary as findSummary } from "@/components/leads/EmailTools";
import { originText } from "@/lib/leads/table";
import { Pager, usePaged } from "@/components/Pager";
import { LEAD_STAGES, type LeadStage, type LeadTableRow } from "@/lib/leads/types";
import { QualifyControls, RowCheck } from "@/components/qualifier/QualifyControls";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { openedFromList } from "@/components/leads/LeadModal";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

const SEGMENT_TABS: (SegmentTab | "all")[] = ["all", "large", "small", "residential", "none"];
const STAGE_TABS: (LeadStage | "all")[] = [...LEAD_STAGES, "all"];

const GRID = "md:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,0.8fr)]";
// the same columns plus the AI question's (Tailwind needs both class names written out)
const GRID_AI = "md:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,1.6fr)]";

const linkBtn = "inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash";
/** Size and stage buttons: navy when picked, the count in a pill (honey when picked; text on honey stays navy). */
const pickCls = (on: boolean) => `k-btn border-2 text-left ${on ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink"}`;
const pillCls = (on: boolean) => `rounded-full px-2 font-mono text-sm font-normal ${on ? "bg-honey text-ink" : "bg-cold text-[#4a5361]"}`;
const MUTED = "text-[#4a5361]";
/** Mirrors FIND_MAX_LEADS in email-actions.ts (a "use server" file cannot export it). */
const FIND_BATCH = 25;
const menuItem = "flex min-h-11 w-full items-center px-4 text-left text-sm text-ink no-underline hover:bg-ground";

type Panel = "nl" | "ai" | "views" | "qualify";

type Props = {
  items: LeadTableRow[];
  canCreate: boolean;
  sources?: { maps: boolean; apollo: boolean; shovels?: boolean; rapidapi?: boolean };
  initialFilters?: LeadFilters;
  views?: LeadView[];
  lists?: { id: string; name: string }[];
  /** Showing one list only (/leads?lista=<id>). */
  list?: { id: string; name: string } | null;
  /** AI questions of the workspace (0029) and the worst-case cost of one answer. */
  questions?: AiQuestion[];
  answerReserveUsd?: number;
  /** Worst-case cost of one "Classificar tipo com IA" batch call (the gateway's reservation). */
  typeReserveUsd?: number;
};

const lastTouch = (iso: string | null, t: Messages) => (iso ? new Date(iso).toLocaleDateString(t.intl, { timeZone: "America/New_York" }) : t.leads.never);

/** Column headers in grid order (null = not sortable); the Entrou em column sits after Último contato. */
const headers = (COL: Messages["leads"]["columns"]): ({ key: SortKey; label: string } | null)[] => [
  { key: "company", label: COL.company }, null, null, null, null, { key: "lastContact", label: COL.lastContact }, { key: "entered", label: COL.entered },
];

/** none -> A-Z/oldest first -> reverse -> back to the default order. */
const nextSort = (s: Sort, key: SortKey): Sort => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null);

/** Typing stays local; the filter (and the whole list) only updates 200 ms after the last keystroke. */
function SearchBox({ value, set }: { value: string; set: (patch: Partial<LeadFilters>) => void }) {
  const t = useT();
  const L = t.leads;
  const [q, setQ] = useState(value);
  useEffect(() => {
    if (q === value) return;
    const id = setTimeout(() => set({ q }), 200);
    return () => clearTimeout(id);
  }, [q, value, set]);
  return (
    <label className="k-field flex min-h-[58px] min-w-0 flex-[999_1_420px] items-center gap-3 rounded-[16px] border-2 border-line bg-surface px-[18px]">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4A5361" strokeWidth="2" strokeLinecap="round" aria-hidden className="shrink-0">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <span className="sr-only">{L.steps.searchLabel}</span>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.filters.search} className="min-w-0 flex-1 bg-transparent text-ink" />
    </label>
  );
}

/** A numbered step of the filter card; the hexagon turns when the step is hovered. */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <>
      <h2 className="flex items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">
        <HexIcon n={n} turn />
        {title}
      </h2>
      {children}
    </>
  );
}

export function LeadsTable({ items, canCreate, sources = { maps: false, apollo: false }, initialFilters = DEFAULT_LEAD_FILTERS, views = [], lists = [], list = null, questions = [], answerReserveUsd = 0, typeReserveUsd = 0 }: Props) {
  const t = useT();
  const L = t.leads;
  const TB = t.leads.toolbar;
  const COL = t.leads.columns;
  const P = t.leads.paging;
  const [f, setF] = useState<LeadFilters>(initialFilters);
  // bumped when a saved view replaces every filter, so the search box takes the view's text
  const [searchKey, setSearchKey] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  // rows fade up on the first paint only, not on every filter change
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setIntro(false), 1500);
    return () => clearTimeout(id);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const search = useSearchParams();
  // The Home's "Quem você quer achar hoje?" sends ?ia=<text>: open "Busca com IA" with it (senders only, like the menu item)
  const pathname = usePathname();
  const iaText = canCreate ? search.get("ia")?.slice(0, 200) ?? null : null;
  const [openPanel, setOpenPanel] = useState<Panel | null>(iaText === null ? null : "nl");
  const [csvError, setCsvError] = useState<string | null>(null);
  // the last bulk result (status / type); kept here because a success unmounts the selection bar
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  const router = useRouter();
  // read once, then drop ?ia from the URL (other params stay) so a reload or a lead link does not reopen the panel
  useEffect(() => {
    if (!search.has("ia")) return;
    const p = new URLSearchParams(search);
    p.delete("ia");
    router.replace(`${pathname}${p.size ? `?${p}` : ""}`, { scroll: false });
  }, [search, pathname, router]);
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
  const [sort, setSort] = useState<Sort>(null);
  const filtered = useMemo(() => sortRows(filterLeads(items, f), sort), [items, f, sort]);
  const filteredIds = useMemo(() => filtered.map((i) => i.lead.id), [filtered]);
  const selected = useMemo(() => filteredIds.filter((id) => picked.has(id)), [filteredIds, picked]);
  // Paging only slices what is rendered; any filter/size change goes back to page 1.
  const { pageItems, pager } = usePaged(filtered, JSON.stringify([f, sort]));
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
  const activeTotal = useMemo(() => LEAD_STAGES.reduce((n, s) => n + facets.stages[s], 0), [facets]);
  const agents = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of items) if (i.lead.origin_agent_id && i.agentName) m.set(i.lead.origin_agent_id, i.agentName);
    return [...m.entries()];
  }, [items]);
  const hasOneOff = useMemo(() => items.some((i) => i.lead.origin_kind === "one_off"), [items]);
  const nameById = useMemo(() => new Map(items.map((i) => [i.lead.id, i.display.name])), [items]);
  const cities = useMemo(() => [...new Set(items.map((i) => i.display.city?.trim()).filter((c): c is string => Boolean(c)))], [items]);
  const aiQ = useMemo(() => questions.find((q) => q.id === f.aiQuestion) ?? null, [questions, f.aiQuestion]);
  const chips = removableChipKeys(f);
  const summary = useMemo(() => summaryOf(f, filtered.length, agents, t), [f, filtered.length, agents, t]);
  // Leads already searched this visit: a guess never becomes the shown e-mail, so they would stay in the set and be sent again.
  const [searched, setSearched] = useState<Set<string>>(new Set());
  const [finding, startFind] = useTransition();
  const findable = useMemo(() => filtered.filter((i) => hasSiteNoEmail(i) && !searched.has(i.lead.id)).map((i) => i.lead.id), [filtered, searched]);
  const findEmails = () => {
    setMenuOpen(false);
    const ids = findable.slice(0, FIND_BATCH);
    startFind(async () => {
      const r = await findEmailAction(ids);
      if (!r.ok) return setNotice({ ok: false, text: r.error });
      setSearched((s) => new Set([...s, ...ids]));
      const left = findable.length - ids.length;
      setNotice({ ok: true, text: `${fill(TB.findEmailBulkRun, { done: ids.length, total: findable.length, summary: findSummary(r.results, t) })}${left > 0 ? ` ${TB.findEmailBulkMore}` : ""}` });
      router.refresh();
    });
  };
  // "Classificar tipo com IA": leads sent this visit are not sent again (an "unknown" stays Sem tipo)
  const [typeTried, setTypeTried] = useState<Set<string>>(new Set());
  const [confirmType, setConfirmType] = useState(false);
  const [typing, startType] = useTransition();
  const untypedIds = useMemo(() => items.filter((i) => i.segment === null && !typeTried.has(i.lead.id)).map((i) => i.lead.id), [items, typeTried]);
  const typeTarget = untypedIds.slice(0, AI_TYPE_MAX);
  const typeEstimate = Math.ceil(typeTarget.length / AI_TYPE_BATCH) * typeReserveUsd;
  const classifyTypes = () => {
    setConfirmType(false);
    const ids = typeTarget;
    startType(async () => {
      const r = await classifyTypesAction(ids);
      if (!r.ok) return setNotice({ ok: false, text: r.error });
      // a cap or a failed batch: nothing is marked as tried, so the next click picks the rest up
      if (!r.stopText && r.failed === 0) setTypeTried((s) => new Set([...s, ...ids]));
      const left = untypedIds.length - ids.length;
      const more = !r.stopText && left > 0 ? fill(TB.aiTypeMore, { n: left }) : null;
      setNotice({ ok: !r.stopText && r.failed === 0, text: [fill(TB.aiTypeDone, { typed: r.typed, untyped: r.untyped }), r.failed > 0 ? fill(TB.aiTypeBatchFailed, { n: r.failed }) : null, r.stopText, more].filter(Boolean).join(" ") });
      router.refresh();
    });
  };

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
            {sources.shovels && <Link href="/leads/buscar#shovels" className={linkBtn}>{t.sources.search.shovels}</Link>}
            {sources.rapidapi && <Link href="/leads/buscar#b2b" className={linkBtn}>{t.sources.search.b2b}</Link>}
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
    requestAnimationFrame(() => document.getElementById("lead-panel")?.scrollIntoView({ block: "nearest" }));
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

  const ST = L.steps;
  const clearAll = () => {
    set(clearAllPatch(f));
    setSearchKey((k) => k + 1);
  };
  const closeFilters = () => {
    setShowFilters(false);
    moreBtn.current?.focus();
  };
  let step = 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {listBanner}
      {/* the open tool (AI search, AI question, views, qualifier) sits above the filters, where the eye lands; ?ia= from Início opens it here */}
      <div id="lead-panel" className="flex scroll-mt-4 flex-col gap-3 empty:hidden">
      {canCreate && openPanel === "nl" && <NlSearch cities={cities} initialText={iaText ?? ""} onApply={(nl) => set(nl)} />}
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
      </div>
      <div className="k-in drop-shadow-[0_16px_22px_rgba(15,27,61,0.09)] [animation-delay:.3s]">
        <div className="hx bg-[#e3e6ec] p-[1.5px] [--c:10px] md:[--c:22px]">
          <section aria-label={ST.filtersLabel} className="hx flex flex-col gap-[26px] bg-surface px-7 py-7 [--c:9.4px] md:px-[38px] md:[--c:21.4px]">
            {canCreate && (
              <div role="group" aria-label={L.segments.label} className="k-step flex flex-col gap-3">
                <Step n={++step} title={L.segments.label}>
                  <div className="flex flex-wrap gap-2">
                    {SEGMENT_TABS.map((x) => (
                      <button key={x} type="button" aria-pressed={f.segment === x} onClick={() => pickTab({ segment: x })} className={`${pickCls(f.segment === x)} inline-flex min-h-[52px] items-center gap-2.5 rounded-[14px] px-[18px] font-medium`}>
                        {L.segments[x]} <span className={pillCls(f.segment === x)}>{facets.segments[x]}</span>
                      </button>
                    ))}
                  </div>
                </Step>
              </div>
            )}
            <div role="group" aria-label={ST.stage} className="k-step flex flex-col gap-3">
              <Step n={++step} title={ST.stage}>
                <div className="flex flex-wrap items-stretch gap-1.5">
                  {STAGE_TABS.map((x, n) => {
                    const on = f.stage === x;
                    return (
                      <div key={x} className="flex items-center gap-1.5">
                        <button type="button" aria-pressed={on} onClick={() => pickTab({ stage: x })} className={`${pickCls(on)} flex min-h-[68px] min-w-[132px] flex-col items-start justify-center rounded-[16px] px-4 py-2`}>
                          <span className="flex items-center gap-2 font-semibold">
                            {x === "all" ? ST.stageAll : L.stages[x]} <span className={pillCls(on)}>{x === "all" ? activeTotal : facets.stages[x]}</span>
                          </span>
                          <span className={`text-sm ${on ? "text-[#d5dae6]" : MUTED}`}>{ST.stageHints[x]}</span>
                        </button>
                        {n < LEAD_STAGES.length - 1 && <Chevron className="shrink-0 text-[#b3bac6]" />}
                      </div>
                    );
                  })}
                </div>
              </Step>
            </div>
            <div className="k-step flex flex-col gap-3">
              <Step n={++step} title={ST.search}>
                <div className="flex flex-wrap gap-2.5">
                  <SearchBox key={searchKey} value={f.q} set={set} />
                  <button ref={moreBtn} type="button" aria-haspopup="dialog" aria-expanded={showFilters} aria-controls="lead-filters" onClick={() => setShowFilters(true)} className="k-lift flex flex-[1_1_220px] font-semibold text-ink">
                    <span className="hx flex flex-1 bg-ink p-[2px] [--c:14px]">
                      <span className="hx hx-fill inline-flex min-h-[54px] flex-1 flex-wrap items-center justify-center gap-x-2.5 bg-surface px-[30px] [--c:13.4px]">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                          <path d="M4 6h16M7 12h10M10 18h4" />
                        </svg>
                        {ST.moreFilters} <span className={`font-normal ${MUTED}`}>{ST.moreFiltersHint}</span>
                        <Chevron className="k-arrow" />
                      </span>
                    </span>
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`mr-1 text-base ${MUTED}`}>{ST.shortcuts}</span>
                  {SHORTCUT_CHIPS.map((c) => {
                    const on = c.on(f);
                    return (
                      <button key={c.id} type="button" aria-pressed={on} onClick={() => set(c.patch(!on))} className={`k-btn inline-flex min-h-[46px] items-center gap-2 rounded-full border-2 pr-[18px] text-base text-ink ${on ? "border-honey bg-honey-light pl-2.5 font-semibold" : "border-line bg-surface pl-[18px]"}`}>
                        {on && (
                          <span aria-hidden className="k-pop inline-flex size-6 items-center justify-center rounded-full bg-ink text-white">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M5 12l5 5L20 7" />
                            </svg>
                          </span>
                        )}
                        {ST.chips[c.id]}
                      </button>
                    );
                  })}
                </div>
              </Step>
            </div>

            <div className="hx bg-honey-edge p-[2px] [--c:10px] md:[--c:16px]">
              <div className="hx flex flex-wrap items-center justify-between gap-3 bg-honey-soft py-5 pl-8 pr-[30px] [--c:9.4px] md:[--c:15.4px]">
                <div className="flex min-w-0 flex-[1_1_300px] items-center gap-3">
                  <HexIcon size={26} />
                  <p className="m-0 min-w-0 text-lg">
                    <span key={summary} className="k-fade inline-block">
                      <b className="font-semibold">{t.leads.summary.label}</b> {summary}
                    </span>
                  </p>
                </div>
                <p aria-live="polite" className="sr-only">{`${t.leads.summary.label} ${countOf(filtered.length, t)}`}</p>
                <button type="button" onClick={clearAll} className="k-btn min-h-12 rounded-[12px] border-2 border-ink bg-surface px-5 font-semibold text-ink">
                  {ST.clearAll}
                </button>
              </div>
            </div>

            {chips.length > 0 && (
              <div className="-mt-3 flex flex-wrap items-center gap-2">
                {chips.map((k) => {
                  const value = chipValue(k, f, agents, t);
                  const label = `${L.chips[k as keyof typeof L.chips]}${value ? `: ${value}` : ""}`;
                  return (
                    <span key={k} className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border-2 border-honey bg-honey-light pl-4 text-[15px] text-ink">
                      <span className="min-w-0 truncate">{label}</span>
                      <button type="button" aria-label={fill(TB.removeChip, { label })} onClick={() => set(clearPatch([k]))} className="k-btn min-h-11 min-w-11 rounded-full text-lg">
                        <span aria-hidden>×</span>
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <FilterDialog open={showFilters} onClose={closeFilters} n={filtered.length} onClear={() => set(clearPatch(panelFilterKeys(f)))}>
        <FacetPanel facets={facets} f={f} set={set} agents={agents} hasOneOff={hasOneOff} />
      </FilterDialog>

      <section aria-label={ST.companies} className="k-in flex min-w-0 flex-col gap-3 [animation-delay:.38s]">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <p className={`m-0 text-base ${MUTED}`}>
            {TB.order} <span className="font-mono text-sm">· {filtered.length} / {items.length}</span>
          </p>
          {canCreate && (
            <div className="relative" onKeyDown={(e) => e.key === "Escape" && setMenuOpen(false)}>
              <button
                type="button"
                aria-label={TB.more}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((x) => !x)}
                className="k-btn min-h-12 min-w-12 rounded-[12px] border-2 border-line bg-surface px-3 text-xl text-ink"
              >
                <span aria-hidden>⋯</span>
              </button>
              {menuOpen && canCreate && (
                <div role="menu" aria-label={TB.more} className="absolute right-0 z-20 mt-1 flex w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[12px] border border-line bg-surface py-1 shadow-[0_12px_28px_-12px_rgba(15,27,61,0.4)]">
                  <Link href="/leads/subir" role="menuitem" className={menuItem}>{t.imports.button}</Link>
                  {sources.maps && <Link href="/leads/buscar#maps" role="menuitem" className={menuItem}>{t.sources.search.maps}</Link>}
                  {sources.apollo && <Link href="/leads/buscar#apollo" role="menuitem" className={menuItem}>{t.sources.search.apollo}</Link>}
                  {sources.shovels && <Link href="/leads/buscar#shovels" role="menuitem" className={menuItem}>{t.sources.search.shovels}</Link>}
                  {sources.rapidapi && <Link href="/leads/buscar#b2b" role="menuitem" className={menuItem}>{t.sources.search.b2b}</Link>}
                  <button type="button" role="menuitem" disabled={finding || findable.length === 0} onClick={findEmails} className={`${menuItem} disabled:text-muted`}>{fill(TB.findEmailBulk, { n: findable.length })}</button>
                  <button type="button" role="menuitem" disabled={typing || untypedIds.length === 0} onClick={() => { setMenuOpen(false); setConfirmType(true); }} className={`${menuItem} disabled:text-muted`}>{fill(TB.aiType, { n: untypedIds.length })}</button>
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
        {canCreate && confirmType && typeTarget.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border border-line bg-surface p-3">
            <p className="m-0 min-w-0 flex-[1_1_240px] text-sm text-ink">{fill(TB.aiTypeEstimate, { usd: `US$ ${usd(typeEstimate, t.intl)}`, n: typeTarget.length })}</p>
            <button type="button" onClick={classifyTypes} className={linkBtn}>{TB.aiTypeRun}</button>
            <button type="button" onClick={() => setConfirmType(false)} className="min-h-11 px-3 text-sm text-blue underline underline-offset-4">{TB.aiTypeCancel}</button>
          </div>
        )}
        {typing && <p role="status" className="m-0 text-sm text-muted">{TB.aiTypeRunning}</p>}

        {notice && <p role="status" className={`m-0 text-sm ${notice.ok ? "text-ok" : "text-danger"}`}>{notice.text}</p>}

        {filtered.length === 0 ? (
          <p className={`text-base ${MUTED}`}>{t.research.list.emptyTab}</p>
        ) : (
          <>
            <div>
              <div className="hx bg-[#e3e6ec] p-[1.5px] [--c:18px]">
                {/* side padding keeps every cell clear of the clipped points */}
                <div className="hx overflow-x-auto bg-surface px-[18px] [--c:17.4px]">
                  <div className="md:min-w-[880px]">
                    <div className="hidden border-b border-[#e3e6ec] md:flex" role="row">
                      {canCreate && <span className="w-11 shrink-0" />}
                      <div className={`grid min-w-0 flex-1 px-3.5 py-3 ${aiQ ? GRID_AI : GRID} gap-3 text-[15px] font-semibold ${MUTED}`}>
                        {headers(t.leads.columns).map((h, n) => {
                          const label = [COL.company, COL.type, COL.contact, COL.stage, COL.origin, COL.lastContact, COL.entered][n];
                          if (!h) return <span key={n} role="columnheader">{label}</span>;
                          const on = sort?.key === h.key;
                          return (
                            <span key={n} role="columnheader" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className="min-w-0">
                              <button type="button" aria-label={fill(L.facets.sortBy, { col: h.label })} onClick={() => setSort(nextSort(sort, h.key))} className="min-h-11 max-w-full truncate text-left hover:text-ink">
                                {h.label}{on ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                              </button>
                            </span>
                          );
                        })}
                        {aiQ && <span role="columnheader">{aiQ.question}</span>}
                      </div>
                    </div>
                    <ul className="m-0 flex list-none flex-col p-0">
                      {pageItems.map((i, n) => {
                        const hasEmail = Boolean(i.display.email?.trim());
                        const hasPhone = Boolean(i.display.phone?.trim());
                        return (
                          <li key={i.lead.id} className={`k-row flex items-stretch border-b border-[#eef0f3] last:border-b-0 ${intro && n < 12 ? "k-in" : ""}`} style={intro && n < 12 ? { animationDelay: `${0.45 + n * 0.04}s` } : undefined}>
                            {canCreate && <RowCheck checked={picked.has(i.lead.id)} name={i.display.name} onChange={(v) => toggle(i.lead.id, v)} />}
                            <Link href={leadHref(i.lead.id)} scroll={false} onClick={() => (openedFromList.value = true)} className={`flex min-w-0 flex-1 flex-col gap-1.5 px-3.5 py-4 text-ink no-underline md:grid ${aiQ ? GRID_AI : GRID} md:items-center md:gap-3`}>
                              <span className="min-w-0">
                                <span className="sr-only">{COL.company}: </span>
                                <span className="block truncate text-[17px] font-semibold">{i.display.name}</span>
                                {i.display.city && <span className={`block truncate text-[15px] ${MUTED}`}>{i.display.city}</span>}
                                {i.emailQuality && (
                                  <span className="mt-0.5 block">
                                    <span className="sr-only">{L.facets.emailQuality}: </span>
                                    <EmailBadge quality={i.emailQuality} />
                                  </span>
                                )}
                              </span>
                              <span>
                                <span className="sr-only">{COL.type}: </span>
                                <span className="inline-block rounded-full bg-cold px-3 py-1 text-[15px] font-medium">{L.segments[i.segment ?? "none"]}</span>
                              </span>
                              <span className="flex flex-col text-[15px]">
                                <span className="sr-only">{COL.contact}: </span>
                                <span className={hasPhone ? "" : "text-[#5e6775]"}>{hasPhone ? L.contactIcons.phone : L.contactIcons.noPhone}</span>
                                <span className={hasEmail ? "" : "text-[#5e6775]"}>{hasEmail ? L.contactIcons.email : L.contactIcons.noEmail}</span>
                              </span>
                              <span>
                                <span className="sr-only">{COL.stage}: </span>
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-honey-pill py-1 pl-2.5 pr-3 text-[15px] font-medium">
                                  <span aria-hidden className="size-2 rounded-full bg-honey" />
                                  {L.stages[stageOf(i.lead)]}
                                </span>
                              </span>
                              <span className="truncate text-[15px]" title={i.origins.length > 0 ? i.origins.map((o) => o.name).join(", ") : undefined}>
                                <span className="sr-only">{COL.origin}: </span>
                                {originText(i, t)}
                              </span>
                              <span className="text-[15px]">
                                <span className="md:hidden">{COL.lastContact}: </span>
                                {lastTouch(i.lead.last_touch_at, t)}
                              </span>
                              <span className="font-mono text-[15px]">
                                <span className="md:hidden">{COL.entered}: </span>
                                {lastTouch(i.lead.first_seen_at, t)}
                              </span>
                              {aiQ && (
                                <span className="min-w-0 text-[15px]">
                                  <span className="sr-only">{aiQ.question}: </span>
                                  <span className="font-semibold">{answerText(i.ai?.[aiQ.id], t)}</span>
                                  {i.ai?.[aiQ.id]?.excerpt && <span className={`block truncate ${MUTED}`} title={i.ai[aiQ.id].excerpt ?? undefined}>“{i.ai[aiQ.id].excerpt}” · {i.ai[aiQ.id].label}</span>}
                                </span>
                              )}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
            {canCreate && (
              <label className="flex min-h-12 items-center gap-2.5 text-base">
                <input type="checkbox" checked={pageAllPicked} onChange={(e) => togglePage(e.target.checked)} className="size-[22px] accent-ink" />
                {P.selectPage}
              </label>
            )}
            <Pager pager={pager} />
          </>
        )}
      </section>

      {canCreate && selected.length > 0 && (
        <div className="sticky bottom-0 z-10">
          <SelectionBar selected={selected} lists={lists} onOpenQualifier={openQualifier} onResult={onBulkResult} />
        </div>
      )}
    </div>
  );
}
