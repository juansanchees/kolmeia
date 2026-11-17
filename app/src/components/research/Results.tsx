"use client";

import Link from "next/link";
import { Pager, usePaged } from "@/components/Pager";
import { useMemo, useRef, useState, useTransition } from "react";
import { createResearchList, setDecision } from "@/app/(app)/agentes/actions";
import type { CandidateRow, JobRow, RunRow } from "@/lib/research/rows";
import { TEMPERATURE_RULE } from "@/lib/research/rules";
import { byTemperature, coverage, inTab, jobSheetColumns, sheetColumns, TABS, toCsv, toJobsCsv, type Column, type JobColumn, type Tab } from "@/lib/research/sheet";
import type { CheckWithEvidence } from "@/lib/research/store";
import { TEMPERATURES, type Decision } from "@/lib/research/types";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { GhostButton, Meter, Pill, Stat } from "./controls";
import { Chevron, CountPill, EmptyState, HexButton, HexPanel, Notice, SegmentedTabs, Select, TextInput } from "@/components/ui";
import { count, date, host, money, moneyFull, UNKNOWN } from "./format";
import { Hook, ProofList } from "./proof";

const MONO = "font-mono text-[13px] uppercase tracking-wide text-[#4a5361]";
const LINK = "k-link text-ink underline decoration-honey decoration-2 underline-offset-2";
const LINK_MONO = "k-link inline-flex min-h-11 items-center self-start font-mono text-sm text-ink underline decoration-honey decoration-2 underline-offset-4";
const BOX = "flex flex-col gap-3 rounded-2xl bg-surface p-4";
const BOX_TITLE = "m-0 font-mono text-[13px] font-normal uppercase tracking-wide text-[#4a5361]";
const FIELD = "flex flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink";
const TABLE_WRAP = "max-h-[620px] overflow-auto rounded-2xl border border-[#e3e6ec] bg-surface";

type Props = {
  run: Pick<RunRow, "id" | "title" | "region_text" | "status" | "is_partial" | "partial_reason" | "limits_notes">;
  candidates: CandidateRow[];
  checks: CheckWithEvidence[];
  /** G10 "Obras sem construtora". */
  jobs?: JobRow[];
};

/** Prototypes "Lista" (Fichas) and "Planilha": the same list two ways, with proof, limits and coverage. */
export function Results({ run, candidates, checks, jobs = [] }: Props) {
  const t = useT();
  const L = t.research.list;
  const LB = t.research.labels;
  const now = useMemo(() => new Date(), []);
  const [mode, setMode] = useState<"cards" | "sheet">("cards");
  const [tab, setTab] = useState<Tab>("call");
  const [selected, setSelected] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(candidates.map((c) => [c.id, c.user_decision])),
  );
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [, start] = useTransition();

  const rows = useMemo(
    () => candidates.map((c) => ({ ...c, user_decision: decisions[c.id] ?? c.user_decision })),
    [candidates, decisions],
  );
  const tabRows = useMemo(() => rows.filter((c) => inTab(c, tab)).sort(byTemperature), [rows, tab]);
  const { pageItems: cardRows, pager: cardPager } = usePaged(tabRows, tab);
  const checksBy = useMemo(() => {
    const m = new Map<string, CheckWithEvidence[]>();
    for (const k of checks) m.set(k.candidate_id, [...(m.get(k.candidate_id) ?? []), k]);
    return m;
  }, [checks]);

  const decide = (id: string, d: Decision) => {
    const prev = decisions[id];
    const next = prev === d ? "pending" : d;
    setDecisions((s) => ({ ...s, [id]: next }));
    start(async () => {
      const r = await setDecision(run.id, id, next);
      if (r.status === "error") {
        setDecisions((s) => ({ ...s, [id]: prev }));
        setDecisionError(r.message ?? L.decisionError);
      } else setDecisionError(null);
    });
  };

  const temps = Object.fromEntries(TEMPERATURES.map((x) => [x, rows.filter((c) => c.temperature === x).length]));
  const kept = rows.filter((c) => c.user_decision === "keep").length;
  const selectedRow = rows.find((c) => c.id === selected) ?? null;

  return (
    <div className="flex flex-col gap-5">
      <div className="k-in flex flex-col gap-1">
        <Link href={`/agentes/pesquisa/${run.id}?view=conversa`} className={LINK_MONO}>
          {t.research.running.seeConversation}
        </Link>
        <h2 className="text-3xl">{L.title}</h2>
        <p className="m-0 text-base text-[#4a5361]">
          {run.title} · {run.region_text}
        </p>
      </div>

      {run.is_partial && (
        <Notice tone="warn">
          <span className="font-semibold">{L.partial}</span> {run.partial_reason}
        </Notice>
      )}

      <section aria-label={L.tempSummary} className="k-in grid gap-3 [animation-delay:.06s] [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
        {TEMPERATURES.map((x) => (
          <Stat
            key={x}
            label={LB.temperatureTitle[x]}
            value={temps[x]}
            note={fill(L.tempRule[x], { large: new Intl.NumberFormat(t.intl).format(TEMPERATURE_RULE.largeJobUsd), days: TEMPERATURE_RULE.veryRecentDays, reviews: TEMPERATURE_RULE.strongPresenceReviews })}
          />
        ))}
      </section>

      <div className="k-in flex flex-col gap-3 [animation-delay:.1s]">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedTabs
            label={L.modeLabel}
            value={mode}
            onChange={setMode}
            items={[
              { value: "cards", label: L.cards },
              { value: "sheet", label: L.sheet },
            ]}
          />
          <span className="text-[15px] text-[#4a5361]">{L.sameList}</span>
        </div>
        <SegmentedTabs label={L.tabsLabel} value={tab} onChange={setTab} items={TABS.map((x) => ({ value: x, label: L.tabs[x], count: x === "jobs" ? jobs.length : rows.filter((c) => inTab(c, x)).length }))} />
      </div>

      {decisionError && (
        <p role="alert" className="m-0 text-base font-medium text-danger">
          {decisionError}
        </p>
      )}

      <div key={`${tab}-${mode}`} className="k-fade">
      {tab === "jobs" ? (
        <Jobs jobs={jobs} mode={mode} />
      ) : mode === "cards" ? (
        <div className="flex flex-wrap items-start gap-5">
          <section aria-label={L.tabs[tab]} className="flex min-w-0 flex-[2_1_480px] flex-col gap-4">
            {tabRows.length === 0 && <EmptyState title={L.emptyTab} />}
            {cardRows.map((c) => (
              <Card key={c.id} c={c} selected={selected === c.id} onSelect={() => setSelected(c.id)} onDecide={(d) => decide(c.id, d)} />
            ))}
            <Pager pager={cardPager} />
          </section>
          <aside aria-label={`${L.proof} · ${L.limits}`} className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
            <section aria-labelledby="proof-title" className={`${BOX} border-2 border-honey-edge`}>
              <h2 id="proof-title" className={BOX_TITLE}>
                {L.proof}
                {selectedRow ? ` · ${selectedRow.name}` : ""}
              </h2>
              {selectedRow ? <ProofList c={selectedRow} checks={checksBy.get(selectedRow.id) ?? []} now={now} /> : <p className="m-0 text-base text-[#4a5361]">{L.proofEmpty}</p>}
            </section>
            <Limits notes={run.limits_notes} />
            <Coverage rows={rows} />
          </aside>
        </div>
      ) : (
        <Sheet rows={tabRows} checksBy={checksBy} onDecide={decide} />
      )}
      </div>

      <BottomBar runId={run.id} kept={kept} tabRows={tabRows} jobs={jobs} tab={tab} />
    </div>
  );
}

// ---------------------------------------------------------------- card
function Card({ c, selected, onSelect, onDecide }: { c: CandidateRow; selected: boolean; onSelect: () => void; onDecide: (d: Decision) => void }) {
  const t = useT();
  const L = t.research.list;
  const LB = t.research.labels;
  return (
    <article className={`flex flex-col gap-3.5 rounded-2xl border-2 bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] ${selected ? "border-honey shadow-[inset_5px_0_0_var(--color-honey)]" : "border-[#e3e6ec]"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-body text-[22px] font-semibold normal-case tracking-normal">{c.name}</h2>
        <span className="flex flex-wrap gap-1.5">
          {c.temperature && <Pill tone={c.temperature}>{LB.temperature[c.temperature]}</Pill>}
          {c.second_pass === "refuted" && <Pill tone="no">{L.refuted}</Pill>}
          {c.second_pass === "unsure" && <Pill tone="unknown">{L.unsure}</Pill>}
          {c.is_partial && <Pill tone="unknown">{t.research.partialTag}</Pill>}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className={MONO}>{L.askFor}</span>
          <span className="text-base font-semibold">
            {c.ask_for_name ? `${c.ask_for_name}${c.ask_for_title ? ` · ${c.ask_for_title}` : ""}` : UNKNOWN}
          </span>
          {c.name_confidence && (
            <span className="text-[15px] text-[#4a5361]">
              {L.confidence} {LB.confidence[c.name_confidence]}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={MONO}>{L.contact}</span>
          <span className="text-base font-semibold">
            {c.phone ?? UNKNOWN}
            {c.phone && !c.phone_source_url && <span className="ml-1.5 text-[15px] font-normal text-[#4a5361]">{L.unverified}</span>}
          </span>
          <span className="text-[15px] text-[#4a5361]">
            {[c.city, c.email_type ? LB.emailType[c.email_type] : null].filter(Boolean).join(" · ")}
            {c.website && (
              <>
                {" · "}
                <a href={c.website} target="_blank" rel="noopener noreferrer" className={LINK}>
                  {host(c.website)}
                </a>
              </>
            )}
          </span>
        </div>
      </div>

      <dl className="m-0 grid grid-cols-3 gap-2 rounded-[14px] bg-ground px-3.5 py-3">
        {[
          [L.permits, count(c.permit_count, t.intl)],
          [L.totalValue, money(c.total_value_usd, t.intl)],
          [L.lastPermit, date(c.last_permit_date, t.intl)],
        ].map(([k, v]) => (
          <div key={k} className="flex min-w-0 flex-col">
            <dt className={MONO}>{k}</dt>
            <dd className="m-0 font-display text-xl font-bold sm:text-2xl">{v}</dd>
          </div>
        ))}
      </dl>

      {c.biggest_job_address && (
        <p className="m-0 text-base">
          <span className="font-semibold">{L.biggestJob}</span> {c.biggest_job_address} · {money(c.biggest_job_value_usd, t.intl)}
          {c.biggest_job_description ? ` · ${c.biggest_job_description}` : ""}
        </p>
      )}

      {c.hook && <Hook text={c.hook} />}

      {(c.signal_match || c.name_source_url || c.name_note || c.notes) && (
        <p className="m-0 text-[15px] text-[#4a5361]">
          {(c.signal_match || c.name_source_url) && <span className="font-semibold text-ink">{L.sources} </span>}
          {c.signal_match}
          {c.name_source_url && (
            <>
              {c.signal_match ? " · " : ""}
              <a href={c.name_source_url} target="_blank" rel="noopener noreferrer" className={LINK}>
                {host(c.name_source_url)}
              </a>
            </>
          )}
          {(c.name_note || c.notes) && (
            <>
              {" "}
              <span className="font-semibold text-ink">{L.note}</span> {[c.name_note, c.notes].filter(Boolean).join(" ")}
            </>
          )}
        </p>
      )}

      {c.supplier_portal_url && (
        <a href={c.supplier_portal_url} target="_blank" rel="noopener noreferrer" className={`${LINK} self-start text-base`}>
          {t.research.sheet.portal}
        </a>
      )}

      <Decide c={c} onDecide={onDecide} extra={<GhostButton onClick={onSelect} aria-pressed={selected}>{L.showProof}</GhostButton>} />
    </article>
  );
}

function Decide({ c, onDecide, extra }: { c: CandidateRow; onDecide: (d: Decision) => void; extra?: React.ReactNode }) {
  const t = useT();
  const L = t.research.list;
  return (
    <div role="group" aria-label={c.name} className="flex flex-wrap gap-2">
      <button
        type="button"
        aria-pressed={c.user_decision === "keep"}
        onClick={() => onDecide("keep")}
        className={`k-btn min-h-11 rounded-[12px] border-2 px-4 text-[15px] font-semibold ${c.user_decision === "keep" ? "border-ok bg-ok text-white" : "border-line bg-surface text-ink hover:border-ink"}`}
      >
        {L.keep}
      </button>
      <button
        type="button"
        aria-pressed={c.user_decision === "drop"}
        onClick={() => onDecide("drop")}
        className={`k-btn min-h-11 rounded-[12px] border-2 px-4 text-[15px] font-semibold ${c.user_decision === "drop" ? "border-warn bg-warn text-white" : "border-line bg-surface text-ink hover:border-ink"}`}
      >
        {L.drop}
      </button>
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------- proof, limits, coverage
function Limits({ notes }: { notes: RunRow["limits_notes"] }) {
  const t = useT();
  const L = t.research.list;
  return (
    <section aria-labelledby="limits-title" className={`${BOX} border border-[#e3e6ec]`}>
      <h2 id="limits-title" className={BOX_TITLE}>
        {L.limits}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px]">
        {notes.map((n, i) => (
          <li key={i} className={n.kind === "blocked" || n.kind === "partial" ? "text-warn" : ""}>
            {n.text}
          </li>
        ))}
        {L.limitsStatic.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </section>
  );
}

function Coverage({ rows }: { rows: CandidateRow[] }) {
  const t = useT();
  const L = t.research.list;
  const c = coverage(rows);
  const line = (label: string, n: number) => (
    <li className="flex flex-col gap-1.5 border-t border-[#e3e6ec] py-2 first:border-t-0">
      <span className="flex justify-between gap-2 text-[15px]">
        <span>{label}</span>
        <span className="font-mono">
          {n} {L.of} {c.total}
        </span>
      </span>
      <Meter value={n} max={c.total} />
    </li>
  );
  return (
    <section aria-labelledby="coverage-title" className={`${BOX} border border-[#e3e6ec]`}>
      <h2 id="coverage-title" className={BOX_TITLE}>
        {L.coverage}
      </h2>
      <ul className="m-0 list-none p-0">
        {line(L.coverageName, c.name)}
        {line(L.coveragePhone, c.phone)}
        {line(L.coverageSite, c.site)}
        {line(L.coverageEmail, c.email)}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- sheet
function cellText(col: Column, c: CandidateRow, t: Messages): string {
  const v = col.get(c);
  if (v === null || v === undefined || v === "") return "";
  if (col.kind === "money") return moneyFull(Number(v), t.intl);
  if (col.kind === "date") return date(String(v), t.intl);
  if (col.kind === "number") return new Intl.NumberFormat(t.intl).format(Number(v));
  return String(v);
}

function Sheet({ rows, checksBy, onDecide }: { rows: CandidateRow[]; checksBy: Map<string, CheckWithEvidence[]>; onDecide: (id: string, d: Decision) => void }) {
  const t = useT();
  const L = t.research.list;
  const LB = t.research.labels;
  const now = useMemo(() => new Date(), []);
  const [q, setQ] = useState("");
  const [ft, setFt] = useState("");
  const [fc, setFc] = useState("");
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const SHEET_COLUMNS = useMemo(() => sheetColumns(t), [t]);

  const cols = SHEET_COLUMNS.filter((c) => all || c.compact);
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter((c) => (!ft || c.temperature === ft) && (!fc || c.name_confidence === fc));
    if (needle) out = out.filter((c) => SHEET_COLUMNS.map((col) => String(col.get(c) ?? "")).join(" \u0001 ").toLowerCase().includes(needle));
    if (sort) {
      const col = SHEET_COLUMNS.find((c) => c.id === sort.id)!;
      const numeric = col.kind === "number" || col.kind === "money";
      out = [...out].sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        if (numeric) return ((x === null ? -Infinity : Number(x)) - (y === null ? -Infinity : Number(y))) * sort.dir;
        return String(x ?? "").localeCompare(String(y ?? ""), t.intl) * sort.dir;
      });
    }
    return out;
  }, [rows, q, ft, fc, sort, SHEET_COLUMNS, t.intl]);

  const { pageItems: viewPage, pager } = usePaged(view, JSON.stringify([q, ft, fc, sort]));
  const toggleSort = (col: Column) =>
    setSort((s) => (s?.id === col.id ? { id: col.id, dir: s.dir === 1 ? -1 : 1 } : { id: col.id, dir: col.kind === "text" || col.kind === "pill" || col.kind === "url" ? 1 : -1 }));
  const openRow = (id: string) => {
    setOpen(id);
    setTimeout(() => detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
  };
  const openC = rows.find((c) => c.id === open) ?? null;
  const tempOptions = [...new Set(rows.map((c) => c.temperature).filter(Boolean))] as NonNullable<CandidateRow["temperature"]>[];
  const confOptions = [...new Set(rows.map((c) => c.name_confidence).filter(Boolean))] as NonNullable<CandidateRow["name_confidence"]>[];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-2xl border border-[#e3e6ec] bg-surface px-4 py-3.5">
        <label className={`${FIELD} min-w-0 flex-[1_1_220px]`}>
          {L.search}
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.searchPlaceholder} className="font-body normal-case tracking-normal" />
        </label>
        <label className={`${FIELD} flex-[1_1_140px]`}>
          {L.tempFilter}
          <Select value={ft} onChange={(e) => setFt(e.target.value)} className="font-body normal-case tracking-normal">
            <option value="">{L.all}</option>
            {tempOptions.map((x) => (
              <option key={x} value={x}>
                {LB.temperatureTitle[x]}
              </option>
            ))}
          </Select>
        </label>
        <label className={`${FIELD} flex-[1_1_140px]`}>
          {L.confFilter}
          <Select value={fc} onChange={(e) => setFc(e.target.value)} className="font-body normal-case tracking-normal">
            <option value="">{L.all}</option>
            {confOptions.map((x) => (
              <option key={x} value={x}>
                {LB.confidence[x]}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-h-12 items-center gap-2 text-base">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="size-[20px] accent-ink" />
          {L.allColumns}
        </label>
        <span className="font-mono text-sm text-[#4a5361]" aria-live="polite">
          {fill(L.rowsCount, { a: view.length, b: rows.length, c: cols.length, d: SHEET_COLUMNS.length })}
        </span>
      </div>

      <div className={TABLE_WRAP} role="region" aria-label={L.sheet} tabIndex={0}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {cols.map((col, i) => (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={sort?.id === col.id ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                  className={`sticky top-0 z-[1] whitespace-nowrap border-b-2 border-[#e3e6ec] bg-ground p-0 text-left ${i === 0 ? "left-0 z-[2] md:sticky" : ""}`}
                >
                  <button type="button" onClick={() => toggleSort(col)} className={`block min-h-11 w-full px-3 py-2.5 font-mono text-[13px] font-medium text-[#4a5361] hover:bg-honey-hover hover:text-ink ${col.kind === "number" || col.kind === "money" ? "text-right" : "text-left"}`}>
                    {col.header}
                    {sort?.id === col.id ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="px-4 py-7 text-[#4a5361]">
                  {L.noMatch}
                </td>
              </tr>
            )}
            {viewPage.map((c) => (
              <tr
                key={c.id}
                tabIndex={0}
                aria-selected={open === c.id}
                onClick={() => openRow(c.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openRow(c.id);
                  }
                }}
                className={`cursor-pointer odd:bg-surface even:bg-[#fafbfc] hover:bg-honey-hover ${open === c.id ? "!bg-honey-light" : ""}`}
              >
                {cols.map((col, i) => {
                  const text = cellText(col, c, t);
                  const numeric = col.kind === "number" || col.kind === "money";
                  return (
                    <td
                      key={col.id}
                      title={text || undefined}
                      className={`max-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-[#eef0f3] px-3 py-2.5 align-middle text-[15px] md:max-w-[360px] ${numeric ? "text-right font-mono text-sm tabular-nums" : ""} ${i === 0 ? "bg-inherit font-semibold md:sticky md:left-0 md:shadow-[1px_0_0_var(--color-line)]" : ""}`}
                    >
                      {col.id === "temperature" && c.temperature ? (
                        <Pill tone={c.temperature}>{LB.temperature[c.temperature]}</Pill>
                      ) : col.id === "confidence" && c.name_confidence ? (
                        <Pill tone={c.name_confidence}>{LB.confidence[c.name_confidence]}</Pill>
                      ) : text ? (
                        text
                      ) : numeric || col.id === "askFor" ? (
                        <span className="text-[#4a5361]">{UNKNOWN}</span>
                      ) : (
                        ""
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} />
      <p className="m-0 text-[15px] text-[#4a5361]">{L.sortHint}</p>

      {openC && (
        <section ref={detailRef} aria-label={openC.name} className="k-fade flex flex-col gap-3.5 rounded-2xl border-2 border-honey-edge bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e3e6ec] pb-3">
            <h2 className="font-body text-[22px] font-semibold normal-case tracking-normal">{openC.name}</h2>
            <GhostButton onClick={() => setOpen(null)}>{L.closeRecord}</GhostButton>
          </div>
          {openC.hook && <Hook text={openC.hook} />}
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6">
            {SHEET_COLUMNS.filter((col) => col.id !== "name" && col.id !== "hook").map((col) => {
              const v = col.get(openC);
              const text = cellText(col, openC, t);
              return (
                <div key={col.id} className="flex min-w-0 flex-col gap-0.5 border-b border-[#e3e6ec] py-2">
                  <dt className={MONO}>{col.header}</dt>
                  <dd className="m-0 text-[15px] [overflow-wrap:anywhere]">
                    {col.kind === "url" && v ? (
                      <a href={String(v)} target="_blank" rel="noopener noreferrer" className={LINK}>
                        {String(v)}
                      </a>
                    ) : (
                      text || UNKNOWN
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          <Decide c={openC} onDecide={(d) => onDecide(openC.id, d)} />
          <div className="flex flex-col gap-2">
            <h3 className={BOX_TITLE}>{L.proof}</h3>
            <ProofList c={openC} checks={checksBy.get(openC.id) ?? []} now={now} />
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- jobs without a builder (G10)
function jobCell(col: JobColumn, j: JobRow, t: Messages): string {
  const v = col.get(j);
  if (v === null || v === undefined || v === "") return "";
  if (col.kind === "money") return moneyFull(Number(v), t.intl);
  if (col.kind === "date") return date(String(v), t.intl);
  return String(v);
}

function Jobs({ jobs, mode }: { jobs: JobRow[]; mode: "cards" | "sheet" }) {
  const t = useT();
  const L = t.research.list;
  const J = t.research.jobs;
  const { pageItems, pager } = usePaged(jobs);
  if (jobs.length === 0) return <EmptyState title={J.empty} />;
  return (
    <section aria-label={L.tabs.jobs} className="flex flex-col gap-3">
      <p className="m-0 text-[15px] text-[#4a5361]">{J.intro}</p>
      {mode === "cards" ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {pageItems.map((j) => (
            <li key={j.id} className="flex flex-col gap-1.5 rounded-2xl border border-[#e3e6ec] bg-surface p-4">
              <span className="text-[17px] font-semibold">{j.address ?? j.project_name}</span>
              {j.address && j.project_name && <span className="text-[15px]">{j.project_name}</span>}
              <span className="text-[15px] text-[#4a5361]">
                {[j.job_type, j.declared_value_usd !== null ? money(j.declared_value_usd, t.intl) : null, j.job_date ? date(j.job_date, t.intl) : null].filter(Boolean).join(" · ") || UNKNOWN}
              </span>
              <span className="text-[14px] text-[#4a5361]">
                <a href={j.source_url} target="_blank" rel="noopener noreferrer" className={LINK}>
                  {host(j.source_url)}
                </a>{" "}
                · {L.seenOn} {date(j.seen_at, t.intl)}
                {j.excerpt && <span className="block italic">“{j.excerpt}”</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={TABLE_WRAP} role="region" aria-label={L.tabs.jobs} tabIndex={0}>
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {jobSheetColumns(t).map((col) => (
                  <th key={col.id} scope="col" className="sticky top-0 whitespace-nowrap border-b-2 border-[#e3e6ec] bg-ground px-3 py-2.5 text-left font-mono text-[13px] font-medium text-[#4a5361]">
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageItems.map((j) => (
                <tr key={j.id} className="odd:bg-surface even:bg-[#fafbfc] hover:bg-honey-hover">
                  {jobSheetColumns(t).map((col) => {
                    const text = jobCell(col, j, t);
                    return (
                      <td key={col.id} title={text || undefined} className="max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-[#eef0f3] px-3 py-2.5 text-[15px]">
                        {col.kind === "url" && text ? (
                          <a href={text} target="_blank" rel="noopener noreferrer" className={LINK}>
                            {host(text)}
                          </a>
                        ) : (
                          text || <span className="text-[#4a5361]">{UNKNOWN}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager pager={pager} />
    </section>
  );
}

// ---------------------------------------------------------------- bottom bar
function BottomBar({ runId, kept, tabRows, jobs, tab }: { runId: string; kept: number; tabRows: CandidateRow[]; jobs: JobRow[]; tab: Tab }) {
  const t = useT();
  const L = t.research.list;
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const download = () => {
    const blob = new Blob([tab === "jobs" ? toJobsCsv(jobs, t) : toCsv(tabRows, sheetColumns(t))], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pesquisa-${L.tabs[tab].toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (kept === 0) {
      setMsg({ ok: false, text: L.listNeedsKeep });
      return;
    }
    start(async () => {
      const r = await createResearchList(runId, name);
      setMsg({ ok: r.status === "success", text: r.message ?? (r.status === "success" ? L.listCreated : L.listError) });
      if (r.status === "success") setName("");
    });
  };

  return (
    <HexPanel as="section" aria-label={L.createList} tone="honey" raised c={18} wrapClassName="bottom-0 z-10 md:sticky" className="flex flex-wrap items-end justify-between gap-4 py-5">
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-base font-semibold">
          <CountPill tone="honey">{kept}</CountPill> {fill(L.keptCount, { n: kept })}
        </span>
        <span className="text-[15px] text-[#4a5361]">{L.useFor}</span>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={`text-base font-medium ${msg.ok ? "text-ok" : "text-danger"}`}>
            {msg.text}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2.5">
        <GhostButton onClick={download} className="min-h-12!">{L.download}</GhostButton>
        <form onSubmit={create} className="flex flex-wrap items-end gap-2.5">
          <label className={FIELD}>
            {L.listName}
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className="w-52 font-body normal-case tracking-normal" />
          </label>
          <HexButton type="submit" disabled={pending}>
            {L.createList} <Chevron className="k-arrow" />
          </HexButton>
        </form>
      </div>
    </HexPanel>
  );
}
