"use client";

import Link from "next/link";
import { useState } from "react";
import { finishImportAction, undoImportAction, importBatchAction, previewBatchAction, startImportAction } from "@/app/(app)/leads/subir/actions";
import { btn, input, Notice } from "@/components/email/bits";
import { detectMapping, hasIdColumn, IMPORT_FIELDS, type ImportField, type Mapping } from "@/lib/imports/fields";
import { ImportFileError, IMPORT_LIMITS, readFileGrid } from "@/lib/imports/parse";
import { mapGrid, previewOutcomes, rowErrorText, type ImportRow, type RowError } from "@/lib/imports/rows";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

type Step = "file" | "columns" | "preview" | "done";
type Counts = { new: number; merged: number; errors: number };
type Entry = ImportRow | RowError;

/** Only a failure the server reported carries copy worth showing; anything else (network, crash) gets the generic text. */
class ActionFail extends Error {}

const isError = (e: Entry): e is RowError => "error" in e;
const STEPS: Step[] = ["file", "columns", "preview", "done"];

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function ImportWizard() {
  const t = useT();
  const M = t.imports;
  const [step, setStep] = useState<Step>("file");
  const [file, setFile] = useState<File | null>(null);
  const [grid, setGrid] = useState<string[][]>([]);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [training, setTraining] = useState(false);
  const [mapping, setMapping] = useState<Mapping>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [existing, setExisting] = useState<Map<number, string | null>>(new Map());
  const [importId, setImportId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [sent, setSent] = useState(0); // batches already stored: a retry continues after them
  const [counts, setCounts] = useState<Counts>({ new: 0, merged: 0, errors: 0 });
  const [dragging, setDragging] = useState(false);

  const load = async (f: File, wanted?: string) => {
    setError(null);
    try {
      const g = await readFileGrid(f, wanted);
      if (g.rows.length < 2) {
        setError(M.fileErrors.empty);
        return;
      }
      if (g.rows[0].length > 500) {
        setError(M.fileErrors.tooManyColumns);
        return;
      }
      if (!wanted && importId && file !== f) {
        // a different file: the earlier, never-finished import would stay in the history as "importing"
        void undoImportAction(importId).catch(() => {});
        setImportId(null);
      }
      setFile(f);
      setGrid(g.rows);
      setSheets(g.sheets);
      setSheet(g.sheet);
      setMapping(detectMapping(g.rows[0]));
      if (!wanted) setListName(f.name.replace(/\.[^.]+$/, "").slice(0, 80));
      setStep("columns");
    } catch (e) {
      setError(e instanceof ImportFileError ? M.fileErrors[e.code] : M.fileErrors.unreadable);
    }
  };

  const setColumn = (i: number, f: ImportField | null) =>
    setMapping((m) => m.map((x, k) => (k === i ? f : f && x === f ? null : x))); // a field is never mapped twice

  const toPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      let id = importId;
      if (!id) {
        const r = await startImportAction({ fileName: file.name, sheetName: sheet, listName: listName.trim(), mapping, useAsTraining: training });
        if (!r.ok) throw new ActionFail(r.error);
        id = r.importId;
        setImportId(id);
      }
      const all = mapGrid(grid, mapping);
      const valid = all.filter((e): e is ImportRow => !isError(e));
      const found = new Map<number, string | null>();
      for (const part of chunk(valid, IMPORT_LIMITS.batch)) {
        const r = await previewBatchAction(id, part);
        if (!r.ok) throw new ActionFail(r.error);
        for (const [row, lead] of r.existing) found.set(row, lead);
      }
      setEntries(all);
      setExisting(found);
      setSent(0);
      setCounts({ new: 0, merged: 0, errors: 0 });
      setStep("preview");
    } catch (e) {
      setError(e instanceof ActionFail ? e.message : M.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!importId) return;
    setBusy(true);
    setError(null);
    const batches = chunk(entries, IMPORT_LIMITS.batch);
    const total = { ...counts };
    try {
      for (let b = sent; b < batches.length; b++) {
        setProgress(Math.min(b * IMPORT_LIMITS.batch, entries.length));
        const r = await importBatchAction(importId, batches[b]);
        if (!r.ok) throw new ActionFail(r.error);
        total.new += r.new;
        total.merged += r.merged;
        total.errors += r.errors;
        setCounts({ ...total });
        setSent(b + 1);
      }
      const f = await finishImportAction(importId);
      if (!f.ok) throw new ActionFail(f.error);
      setStep("done");
    } catch (e) {
      setError(e instanceof ActionFail ? e.message : M.errors.generic);
    } finally {
      setBusy(false);
    }
  };

  const back = () => setStep("file"); // keeps the file session and its import row: no orphan "importing" entry

  const reset = () => {
    setStep("file");
    setFile(null);
    setGrid([]);
    setEntries([]);
    setImportId(null);
    setError(null);
    setSent(0);
  };

  const valid = entries.filter((e): e is ImportRow => !isError(e));
  const errs = entries.filter(isError);
  const outcomes = new Map(previewOutcomes(valid, existing).map((o) => [o.row, o.outcome]));
  const previewNew = [...outcomes.values()].filter((o) => o === "new").length;
  const stepIdx = STEPS.indexOf(step);
  const locked = importId !== null; // the import row already holds the list name and the training choice
  const noId = grid.length > 0 && !hasIdColumn(mapping);

  return (
    <section aria-labelledby="import-title" className="flex min-w-0 flex-col gap-4">
      <h2 id="import-title" className="text-2xl">{M.title}</h2>
      <ol className="m-0 flex list-none flex-wrap gap-2 p-0 font-mono text-xs">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? "step" : undefined} className={`border px-2.5 py-1 ${s === step ? "border-blue text-blue" : "border-line text-muted"}`}>
            {i + 1}. {M.steps[s]}
          </li>
        ))}
      </ol>
      {error && <Notice tone="warn" role="alert">{error}</Notice>}

      {step === "file" && (
        <label
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}
          className={`flex min-h-40 cursor-pointer flex-col items-center justify-center gap-3 border border-dashed p-6 text-center text-sm ${dragging ? "border-blue bg-blue-wash" : "border-edge bg-surface"}`}
        >
          <span>{M.drop}</span>
          <span className={btn.ghost}>{M.choose}</span>
          <input type="file" accept=".csv,.xlsx,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ""; }} />
        </label>
      )}

      {step === "columns" && (
        <div className="flex flex-col gap-4">
          {sheets.length > 1 && (
            <label className="flex flex-col gap-1 text-sm">
              {M.sheet}
              <select value={sheet ?? ""} onChange={(e) => file && void load(file, e.target.value)} className={input}>
                {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            {M.listName}
            <input value={listName} maxLength={80} readOnly={locked} onChange={(e) => setListName(e.target.value)} className={input} />
          </label>
          {locked && <p className="m-0 text-sm text-muted">{M.lockedNote}</p>}
          <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
            {grid[0].map((h, i) => (
              <li key={i} className="grid min-w-0 gap-2 border-b border-line px-3.5 py-2.5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center">
                <span className="min-w-0 truncate text-sm font-semibold" title={h}>{h || `(${i + 1})`}</span>
                <span className="min-w-0 truncate font-mono text-xs text-muted" title={grid[1]?.[i]}>{grid[1]?.[i] ?? ""}</span>
                <select aria-label={`${M.columnMaps}: ${h}`} value={mapping[i] ?? ""} onChange={(e) => setColumn(i, (e.target.value || null) as ImportField | null)} className={input}>
                  <option value="">{M.ignore}</option>
                  {IMPORT_FIELDS.map((f) => <option key={f} value={f}>{M.fields[f]}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-2">
              <input type="checkbox" checked={training} disabled={locked} onChange={(e) => setTraining(e.target.checked)} className="size-5" />
              {M.training}
            </span>
            <span className="text-muted">{M.trainingHelp}</span>
          </label>
          {noId && <Notice tone="warn" role="alert">{M.fileErrors.noIdColumn}</Notice>}
          {!listName.trim() && <p className="m-0 text-sm text-muted">{M.listNameRequired}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={back} className={btn.ghost}>{M.back}</button>
            <button type="button" disabled={busy || noId || !listName.trim()} onClick={() => void toPreview()} className={btn.primary}>
              {busy ? M.previewLoading : M.next}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="flex flex-col gap-4">
          <p className="m-0 font-mono text-sm" role="status">
            {fill(M.previewCounts, { rows: entries.length, new: previewNew, merged: valid.length - previewNew, errors: errs.length })}
          </p>
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="py-1.5 pr-2 font-medium">{M.previewTable.row}</th>
                <th className="py-1.5 pr-2 font-medium">{M.previewTable.company}</th>
                <th className="py-1.5 font-medium">{M.previewTable.status}</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 20).map((e) => (
                <tr key={e.row} className="border-b border-line">
                  <td className="py-1.5 pr-2 font-mono">{e.row}</td>
                  <td className="max-w-0 truncate py-1.5 pr-2">{isError(e) ? (e.data.name ?? "") : e.name}</td>
                  <td className="py-1.5">{isError(e) ? M.outcomes.error : M.outcomes[outcomes.get(e.row) ?? "new"]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {errs.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-base">{M.errorsTitle}</h3>
              <ul className="m-0 list-none p-0 text-[13px]">
                {errs.slice(0, 50).map((e) => <li key={e.row}>{rowErrorText(e.row, e.error, t)}</li>)}
              </ul>
              {errs.length > 50 && <p className="m-0 text-[13px] text-muted">{fill(M.moreErrors, { n: errs.length - 50 })}</p>}
            </div>
          )}
          {busy && <p role="status" className="m-0 font-mono text-sm">{fill(M.progress, { done: progress, total: entries.length })}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || sent > 0} onClick={() => setStep("columns")} className={btn.ghost}>{M.back}</button>
            <button type="button" disabled={busy || entries.length === 0} onClick={() => void run()} className={btn.primary}>
              {error && sent > 0 ? M.retry : M.import}
            </button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-base" role="status">{fill(M.doneCounts, counts)}</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/leads" className={`${btn.primary} no-underline`}>{M.seeLeads}</Link>
            <button type="button" onClick={reset} className={btn.ghost}>{M.another}</button>
          </div>
          <Link href="/agentes" className="text-sm text-blue underline underline-offset-4">{t.qualifier.started}</Link>
        </div>
      )}
      <span className="sr-only">{stepIdx + 1}/{STEPS.length}</span>
    </section>
  );
}
