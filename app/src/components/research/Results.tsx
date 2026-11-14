"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { createResearchList, setDecision } from "@/app/(app)/agentes/actions";
import type { CandidateRow, JobRow, RunRow } from "@/lib/research/rows";
import { TEMPERATURE_RULE } from "@/lib/research/rules";
import { byTemperature, coverage, inTab, JOB_SHEET_COLUMNS, SHEET_COLUMNS, TABS, toCsv, toJobsCsv, type Column, type JobColumn, type Tab } from "@/lib/research/sheet";
import type { CheckWithEvidence } from "@/lib/research/store";
import { TEMPERATURES, type Decision } from "@/lib/research/types";
import { fill, t } from "@/messages/pt";
import { DarkChoice, GhostButton, Pill, PrimaryButton } from "./controls";
import { count, date, host, money, moneyFull, UNKNOWN } from "./format";

const L = t.research.list;
const LB = t.research.labels;
const K = t.research.plan.checks;
const J = t.research.jobs;

type Props = {
  run: Pick<RunRow, "id" | "title" | "region_text" | "status" | "is_partial" | "partial_reason" | "limits_notes">;
  candidates: CandidateRow[];
  checks: CheckWithEvidence[];
  /** G10 "Obras sem construtora". */
  jobs?: JobRow[];
};

/** Prototypes "Lista" (Fichas) and "Planilha": the same list two ways, with proof, limits and coverage. */
export function Results({ run, candidates, checks, jobs = [] }: Props) {
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={`/agentes/pesquisa/${run.id}?view=conversa`} className="font-mono text-xs text-blue underline underline-offset-4">
            {t.research.running.seeConversation}
          </Link>
          <h2 className="mt-1 text-3xl">{L.title}</h2>
          <p className="text-[15px] text-muted">
            {run.title} · {run.region_text}
          </p>
        </div>
      </div>

      {run.is_partial && (
        <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          <span className="font-semibold">{L.partial}</span> {run.partial_reason}
        </p>
      )}

      <section aria-label={L.tempSummary} className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-3">
          {TEMPERATURES.map((x) => (
            <div key={x} className="flex min-w-0 flex-[1_1_150px] flex-col gap-1 border border-line bg-surface p-3.5">
              <span className="font-mono text-xs text-muted">{LB.temperatureTitle[x]}</span>
              <span className="font-display text-4xl font-bold leading-none">{temps[x]}</span>
              <span className="text-[13px] text-muted">
                {fill(L.tempRule[x], { large: new Intl.NumberFormat("pt-BR").format(TEMPERATURE_RULE.largeJobUsd), days: TEMPERATURE_RULE.veryRecentDays, reviews: TEMPERATURE_RULE.strongPresenceReviews })}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={L.modeLabel} className="flex">
          <DarkChoice pressed={mode === "cards"} onClick={() => setMode("cards")}>
            {L.cards}
          </DarkChoice>
          <DarkChoice pressed={mode === "sheet"} onClick={() => setMode("sheet")} className="-ml-px">
            {L.sheet}
          </DarkChoice>
        </div>
        <span className="text-[13px] text-muted">{L.sameList}</span>
      </div>

      <div role="group" aria-label={L.tabsLabel} className="flex flex-wrap gap-2">
        {TABS.map((x) => (
          <DarkChoice key={x} pressed={tab === x} onClick={() => setTab(x)}>
            {L.tabs[x]} · {x === "jobs" ? jobs.length : rows.filter((c) => inTab(c, x)).length}
          </DarkChoice>
        ))}
      </div>

      {decisionError && (
        <p role="alert" className="text-sm text-danger">
          {decisionError}
        </p>
      )}

      {tab === "jobs" ? (
        <Jobs jobs={jobs} mode={mode} />
      ) : mode === "cards" ? (
        <div className="flex flex-wrap items-start gap-5">
          <section aria-label={L.tabs[tab]} className="flex min-w-0 flex-[2_1_480px] flex-col gap-4">
            {tabRows.length === 0 && <p className="border border-line bg-surface p-4 text-sm text-muted">{L.emptyTab}</p>}
            {tabRows.map((c) => (
              <Card key={c.id} c={c} selected={selected === c.id} onSelect={() => setSelected(c.id)} onDecide={(d) => decide(c.id, d)} />
            ))}
          </section>
          <aside aria-label={`${L.proof} · ${L.limits}`} className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
            <section aria-labelledby="proof-title" className="flex flex-col gap-3 border border-ink bg-surface p-4">
              <h2 id="proof-title" className="font-mono text-xs font-normal normal-case tracking-normal text-muted">
                {L.proof}
                {selectedRow ? ` · ${selectedRow.name}` : ""}
              </h2>
              {selectedRow ? <ProofList c={selectedRow} checks={checksBy.get(selectedRow.id) ?? []} /> : <p className="text-sm text-muted">{L.proofEmpty}</p>}
            </section>
            <Limits notes={run.limits_notes} />
            <Coverage rows={rows} />
          </aside>
        </div>
      ) : (
        <Sheet rows={tabRows} checksBy={checksBy} onDecide={decide} />
      )}

      <BottomBar runId={run.id} kept={kept} tabRows={tabRows} jobs={jobs} tab={tab} />
    </div>
  );
}

// ---------------------------------------------------------------- card
function Card({ c, selected, onSelect, onDecide }: { c: CandidateRow; selected: boolean; onSelect: () => void; onDecide: (d: Decision) => void }) {
  return (
    <article className={`flex flex-col gap-3.5 border bg-surface p-4 ${selected ? "border-blue shadow-[inset_3px_0_0_var(--color-blue)]" : "border-line"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[22px]">{c.name}</h2>
        <span className="flex flex-wrap gap-1.5">
          {c.temperature && <Pill tone={c.temperature}>{LB.temperature[c.temperature]}</Pill>}
          {c.second_pass === "refuted" && <Pill tone="no">{L.refuted}</Pill>}
          {c.second_pass === "unsure" && <Pill tone="unknown">{L.unsure}</Pill>}
          {c.is_partial && <Pill tone="unknown">{t.research.partialTag}</Pill>}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-muted">{L.askFor}</span>
          <span className="text-[15px] font-semibold">
            {c.ask_for_name ? `${c.ask_for_name}${c.ask_for_title ? ` · ${c.ask_for_title}` : ""}` : UNKNOWN}
          </span>
          {c.name_confidence && (
            <span className="text-[13px] text-muted">
              {L.confidence} {LB.confidence[c.name_confidence]}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-xs text-muted">{L.contact}</span>
          <span className="text-[15px] font-semibold">
            {c.phone ?? UNKNOWN}
            {c.phone && !c.phone_source_url && <span className="ml-1.5 text-[13px] font-normal text-muted">{L.unverified}</span>}
          </span>
          <span className="text-[13px] text-muted">
            {[c.city, c.email_type ? LB.emailType[c.email_type] : null].filter(Boolean).join(" · ")}
            {c.website && (
              <>
                {" · "}
                <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                  {host(c.website)}
                </a>
              </>
            )}
          </span>
        </div>
      </div>

      <dl className="m-0 grid grid-cols-3 gap-2 border-y border-line py-2.5">
        {[
          [L.permits, count(c.permit_count)],
          [L.totalValue, money(c.total_value_usd)],
          [L.lastPermit, date(c.last_permit_date)],
        ].map(([k, v]) => (
          <div key={k} className="flex min-w-0 flex-col">
            <dt className="font-mono text-xs text-muted">{k}</dt>
            <dd className="m-0 font-display text-xl font-bold sm:text-2xl">{v}</dd>
          </div>
        ))}
      </dl>

      {c.biggest_job_address && (
        <p className="text-sm">
          <span className="font-semibold">{L.biggestJob}</span> {c.biggest_job_address} · {money(c.biggest_job_value_usd)}
          {c.biggest_job_description ? ` · ${c.biggest_job_description}` : ""}
        </p>
      )}

      {c.hook && <Hook text={c.hook} />}

      {(c.signal_match || c.name_source_url || c.name_note || c.notes) && (
        <p className="text-[13px] text-muted">
          {(c.signal_match || c.name_source_url) && <span className="font-semibold text-ink">{L.sources} </span>}
          {c.signal_match}
          {c.name_source_url && (
            <>
              {c.signal_match ? " · " : ""}
              <a href={c.name_source_url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
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
        <a href={c.supplier_portal_url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue underline underline-offset-2">
          {t.research.sheet.portal}
        </a>
      )}

      <Decide c={c} onDecide={onDecide} extra={<GhostButton onClick={onSelect} aria-pressed={selected}>{L.showProof}</GhostButton>} />
    </article>
  );
}

function Decide({ c, onDecide, extra }: { c: CandidateRow; onDecide: (d: Decision) => void; extra?: React.ReactNode }) {
  return (
    <div role="group" aria-label={c.name} className="flex flex-wrap gap-2">
      <button
        type="button"
        aria-pressed={c.user_decision === "keep"}
        onClick={() => onDecide("keep")}
        className={`min-h-11 border px-4 text-sm font-semibold ${c.user_decision === "keep" ? "border-ok bg-ok text-white" : "border-edge bg-surface text-ink hover:border-ink"}`}
      >
        {L.keep}
      </button>
      <button
        type="button"
        aria-pressed={c.user_decision === "drop"}
        onClick={() => onDecide("drop")}
        className={`min-h-11 border px-4 text-sm font-semibold ${c.user_decision === "drop" ? "border-warn bg-warn text-white" : "border-edge bg-surface text-ink hover:border-ink"}`}
      >
        {L.drop}
      </button>
      {extra}
    </div>
  );
}

function Hook({ text }: { text: string }) {
  const ref = useRef<HTMLQuoteElement>(null);
  const [label, setLabel] = useState<string>(L.copyHook);
  const copy = () => {
    const fallback = () => {
      if (!ref.current) return;
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setLabel(L.copyFallback);
    };
    try {
      navigator.clipboard.writeText(text).then(() => {
        setLabel(L.copied);
        setTimeout(() => setLabel(L.copyHook), 1600);
      }, fallback);
    } catch {
      fallback();
    }
  };
  return (
    <div className="flex flex-col gap-2 bg-blue-soft p-3.5">
      <span className="font-mono text-xs text-blue-ink">{L.hook}</span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <q ref={ref} lang="en" className="min-w-0 flex-[1_1_320px] text-base leading-normal [quotes:none]">
          {text}
        </q>
        <button type="button" onClick={copy} aria-live="polite" className="min-h-11 border border-blue bg-blue px-4 text-sm font-semibold text-white">
          {label}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- proof, limits, coverage
function ProofList({ c, checks }: { c: CandidateRow; checks: CheckWithEvidence[] }) {
  const secondPass = c.second_pass;
  const byPass = [1, 2].map((p) => checks.filter((k) => k.pass === p));
  return (
    <div className="flex flex-col gap-3">
      {c.found_at_url && (
        <span className="text-[12px] text-muted">
          <span className="font-semibold text-ink">{L.foundAt} </span>
          <a href={c.found_at_url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
            {c.found_at_title || host(c.found_at_url)}
          </a>
          {c.found_at_seen_at && ` · ${L.seenOn} ${date(c.found_at_seen_at)}`}
          {c.found_at_excerpt && <span className="block italic">“{c.found_at_excerpt}”</span>}
        </span>
      )}
      {byPass.map((list, i) =>
        list.length ? (
          <div key={i} className="flex flex-col gap-2">
            <span className="font-mono text-[11px] uppercase text-blue-ink">
              {L.pass[(i + 1) as 1 | 2]}
              {i === 1 && secondPass ? ` · ${secondPass === "refuted" ? L.refuted : secondPass === "unsure" ? L.unsure : "ok"}` : ""}
            </span>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {list.map((k) => (
                <li key={k.id} className="flex flex-col gap-1 border-t border-line pt-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{K[k.kind]}</span>
                    <Pill tone={k.result}>{LB.result[k.result]}</Pill>
                  </span>
                  <span className="text-[13px]">
                    {k.result === "unknown" && <span className="font-semibold">{L.unknownReason} </span>}
                    {k.summary}
                  </span>
                  {k.evidence.map((e) => (
                    <span key={e.url} className="text-[12px] text-muted">
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                        {e.title || host(e.url)}
                      </a>{" "}
                      · {L.seenOn} {date(e.seen_at)}
                      {e.excerpt && <span className="block italic">“{e.excerpt}”</span>}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}

function Limits({ notes }: { notes: RunRow["limits_notes"] }) {
  return (
    <section aria-labelledby="limits-title" className="flex flex-col gap-2 border border-line bg-surface p-4">
      <h2 id="limits-title" className="font-mono text-xs font-normal normal-case tracking-normal text-muted">
        {L.limits}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
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
  const c = coverage(rows);
  const line = (label: string, n: number) => (
    <li className="flex justify-between gap-2 border-t border-line py-1.5 text-sm">
      <span>{label}</span>
      <span className="font-mono">
        {n} {L.of} {c.total}
      </span>
    </li>
  );
  return (
    <section aria-labelledby="coverage-title" className="flex flex-col border border-line bg-surface p-4">
      <h2 id="coverage-title" className="mb-1 font-mono text-xs font-normal normal-case tracking-normal text-muted">
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
function cellText(col: Column, c: CandidateRow): string {
  const v = col.get(c);
  if (v === null || v === undefined || v === "") return "";
  if (col.kind === "money") return moneyFull(Number(v));
  if (col.kind === "date") return date(String(v));
  if (col.kind === "number") return new Intl.NumberFormat("pt-BR").format(Number(v));
  return String(v);
}

function Sheet({ rows, checksBy, onDecide }: { rows: CandidateRow[]; checksBy: Map<string, CheckWithEvidence[]>; onDecide: (id: string, d: Decision) => void }) {
  const [q, setQ] = useState("");
  const [ft, setFt] = useState("");
  const [fc, setFc] = useState("");
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const detailRef = useRef<HTMLElement>(null);

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
        return String(x ?? "").localeCompare(String(y ?? ""), "pt-BR") * sort.dir;
      });
    }
    return out;
  }, [rows, q, ft, fc, sort]);

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
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 border border-line bg-surface px-3.5 py-3">
        <label className="flex min-w-0 flex-[1_1_220px] flex-col gap-1 font-mono text-xs text-muted">
          {L.search}
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L.searchPlaceholder} className="h-10 border border-edge bg-surface px-2.5 font-body text-sm text-ink" />
        </label>
        <label className="flex flex-[1_1_140px] flex-col gap-1 font-mono text-xs text-muted">
          {L.tempFilter}
          <select value={ft} onChange={(e) => setFt(e.target.value)} className="h-10 border border-edge bg-surface px-2.5 font-body text-sm text-ink">
            <option value="">{L.all}</option>
            {tempOptions.map((x) => (
              <option key={x} value={x}>
                {LB.temperatureTitle[x]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-[1_1_140px] flex-col gap-1 font-mono text-xs text-muted">
          {L.confFilter}
          <select value={fc} onChange={(e) => setFc(e.target.value)} className="h-10 border border-edge bg-surface px-2.5 font-body text-sm text-ink">
            <option value="">{L.all}</option>
            {confOptions.map((x) => (
              <option key={x} value={x}>
                {LB.confidence[x]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-[18px] w-[18px]" />
          {L.allColumns}
        </label>
        <span className="font-mono text-xs text-muted" aria-live="polite">
          {fill(L.rowsCount, { a: view.length, b: rows.length, c: cols.length, d: SHEET_COLUMNS.length })}
        </span>
      </div>

      <div className="max-h-[620px] overflow-auto border border-ink bg-surface" role="region" aria-label={L.sheet} tabIndex={0}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {cols.map((col, i) => (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={sort?.id === col.id ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                  className={`sticky top-0 z-[1] whitespace-nowrap border-b border-ink bg-ground p-0 text-left ${i === 0 ? "left-0 z-[2] md:sticky" : ""}`}
                >
                  <button type="button" onClick={() => toggleSort(col)} className={`block w-full px-3 py-2.5 font-mono text-xs font-medium hover:bg-blue-wash ${col.kind === "number" || col.kind === "money" ? "text-right" : "text-left"}`}>
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
                <td colSpan={cols.length} className="px-4 py-7 text-muted">
                  {L.noMatch}
                </td>
              </tr>
            )}
            {view.map((c) => (
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
                className={`cursor-pointer odd:bg-surface even:bg-[#fafbfc] hover:bg-blue-wash ${open === c.id ? "!bg-blue-soft" : ""}`}
              >
                {cols.map((col, i) => {
                  const text = cellText(col, c);
                  const numeric = col.kind === "number" || col.kind === "money";
                  return (
                    <td
                      key={col.id}
                      title={text || undefined}
                      className={`max-w-[240px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-line px-3 py-2 align-middle md:max-w-[360px] ${numeric ? "text-right font-mono text-[13px] tabular-nums" : ""} ${i === 0 ? "bg-inherit font-semibold md:sticky md:left-0 md:shadow-[1px_0_0_var(--color-line)]" : ""}`}
                    >
                      {col.id === "temperature" && c.temperature ? (
                        <Pill tone={c.temperature}>{LB.temperature[c.temperature]}</Pill>
                      ) : col.id === "confidence" && c.name_confidence ? (
                        <Pill tone={c.name_confidence}>{LB.confidence[c.name_confidence]}</Pill>
                      ) : text ? (
                        text
                      ) : numeric || col.id === "askFor" ? (
                        <span className="text-muted">{UNKNOWN}</span>
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
      <p className="text-[13px] text-muted">{L.sortHint}</p>

      {openC && (
        <section ref={detailRef} aria-label={openC.name} className="flex flex-col gap-3.5 border border-ink bg-surface p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink pb-2.5">
            <h2 className="text-[22px]">{openC.name}</h2>
            <GhostButton onClick={() => setOpen(null)}>{L.closeRecord}</GhostButton>
          </div>
          {openC.hook && <Hook text={openC.hook} />}
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6">
            {SHEET_COLUMNS.filter((col) => col.id !== "name" && col.id !== "hook").map((col) => {
              const v = col.get(openC);
              const text = cellText(col, openC);
              return (
                <div key={col.id} className="flex min-w-0 flex-col gap-0.5 border-b border-line py-2">
                  <dt className="font-mono text-xs text-muted">{col.header}</dt>
                  <dd className="m-0 text-sm [overflow-wrap:anywhere]">
                    {col.kind === "url" && v ? (
                      <a href={String(v)} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
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
            <h3 className="font-mono text-xs font-normal text-muted">{L.proof}</h3>
            <ProofList c={openC} checks={checksBy.get(openC.id) ?? []} />
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- jobs without a builder (G10)
function jobCell(col: JobColumn, j: JobRow): string {
  const v = col.get(j);
  if (v === null || v === undefined || v === "") return "";
  if (col.kind === "money") return moneyFull(Number(v));
  if (col.kind === "date") return date(String(v));
  return String(v);
}

function Jobs({ jobs, mode }: { jobs: JobRow[]; mode: "cards" | "sheet" }) {
  if (jobs.length === 0) return <p className="border border-line bg-surface p-4 text-sm text-muted">{J.empty}</p>;
  return (
    <section aria-label={L.tabs.jobs} className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">{J.intro}</p>
      {mode === "cards" ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-col gap-1.5 border border-line bg-surface p-4">
              <span className="text-[17px] font-semibold">{j.address ?? j.project_name}</span>
              {j.address && j.project_name && <span className="text-sm">{j.project_name}</span>}
              <span className="text-sm text-muted">
                {[j.job_type, j.declared_value_usd !== null ? money(j.declared_value_usd) : null, j.job_date ? date(j.job_date) : null].filter(Boolean).join(" · ") || UNKNOWN}
              </span>
              <span className="text-[12px] text-muted">
                <a href={j.source_url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                  {host(j.source_url)}
                </a>{" "}
                · {L.seenOn} {date(j.seen_at)}
                {j.excerpt && <span className="block italic">“{j.excerpt}”</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="max-h-[620px] overflow-auto border border-ink bg-surface" role="region" aria-label={L.tabs.jobs} tabIndex={0}>
          <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {JOB_SHEET_COLUMNS.map((col) => (
                  <th key={col.id} scope="col" className="sticky top-0 whitespace-nowrap border-b border-ink bg-ground px-3 py-2.5 text-left font-mono text-xs font-medium">
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="odd:bg-surface even:bg-[#fafbfc]">
                  {JOB_SHEET_COLUMNS.map((col) => {
                    const text = jobCell(col, j);
                    return (
                      <td key={col.id} title={text || undefined} className="max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-line px-3 py-2">
                        {col.kind === "url" && text ? (
                          <a href={text} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                            {host(text)}
                          </a>
                        ) : (
                          text || <span className="text-muted">{UNKNOWN}</span>
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
    </section>
  );
}

// ---------------------------------------------------------------- bottom bar
function BottomBar({ runId, kept, tabRows, jobs, tab }: { runId: string; kept: number; tabRows: CandidateRow[]; jobs: JobRow[]; tab: Tab }) {
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const download = () => {
    const blob = new Blob([tab === "jobs" ? toJobsCsv(jobs) : toCsv(tabRows)], { type: "text/csv;charset=utf-8" });
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
    <section aria-label={L.createList} className="bottom-0 flex flex-wrap items-end justify-between gap-4 border border-ink bg-surface p-4 md:sticky">
      <div className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold">{fill(L.keptCount, { n: kept })}</span>
        <span className="text-[13px] text-muted">{L.useFor}</span>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>
            {msg.text}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <GhostButton onClick={download}>{L.download}</GhostButton>
        <form onSubmit={create} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 font-mono text-xs text-muted">
            {L.listName}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className="h-11 w-48 border border-edge bg-surface px-3 font-body text-[15px] text-ink" />
          </label>
          <PrimaryButton type="submit" disabled={pending}>
            {L.createList}
          </PrimaryButton>
        </form>
      </div>
    </section>
  );
}
