"use client";

import Link from "next/link";
import { useState } from "react";
import { finishImportAction, undoImportAction, importBatchAction, previewBatchAction, startImportAction } from "@/app/(app)/leads/subir/actions";
import { Button, Chevron, HexButton, HexLink, HexPanel, Notice, Select, StepTitle, TextInput } from "@/components/ui";
import { SectionIntro } from "@/components/leads/SectionIntro";
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

  const mono = "font-mono text-[13px] font-medium uppercase tracking-wide";
  return (
    <section aria-labelledby="import-title" className="flex min-w-0 flex-col gap-5">
      <SectionIntro id="import-title" title={M.title} subtitle={M.subtitle} />
      <ol className="k-in m-0 flex list-none flex-wrap items-center gap-x-2 gap-y-2 p-0 [animation-delay:.15s]">
        {STEPS.map((s, i) => {
          const now = s === step;
          const past = i < stepIdx;
          return (
            <li key={s} aria-current={now ? "step" : undefined} className="flex items-center gap-2">
              <span className={`inline-flex min-h-11 items-center gap-2 rounded-full py-1 pl-1.5 pr-4 text-base ${now ? "bg-ink font-semibold text-white" : past ? "bg-honey-pill text-ink" : "bg-cold text-[#4a5361]"}`}>
                <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden className="shrink-0">
                  <path className={now || past ? "fill-honey stroke-honey" : "fill-surface stroke-line"} strokeWidth="1.6" strokeLinejoin="round" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
                  <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" className={now || past ? "fill-ink" : "fill-[#4a5361]"}>{i + 1}</text>
                </svg>
                {M.steps[s]}
              </span>
              {i < STEPS.length - 1 && <Chevron size={16} className="text-[#b3bac6]" />}
            </li>
          );
        })}
      </ol>

      <HexPanel c={22} cSm={12} className="flex min-w-0 flex-col gap-5 py-7" wrapClassName="k-in [animation-delay:.22s]">
        <div key={step} className="k-fade flex min-w-0 flex-col gap-5">
          <StepTitle n={stepIdx + 1} hint={M.stepHints[step]}>{M.steps[step]}</StepTitle>
          {error && <Notice tone="danger" role="alert">{error}</Notice>}

          {step === "file" && (
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void load(f); }}
              className={`flex min-h-48 cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-6 text-center text-lg transition-colors has-[input:focus-visible]:border-ink has-[input:focus-visible]:shadow-[0_0_0_5px_rgba(245,164,0,0.3)] ${dragging ? "border-honey bg-honey-soft" : "border-line bg-ground hover:border-edge"}`}
            >
              <span>{M.drop}</span>
              <span className="inline-flex drop-shadow-[0_8px_12px_rgba(15,27,61,0.22)]">
                <span className="hx inline-flex min-h-[54px] items-center justify-center gap-2.5 bg-ink px-[30px] text-[17px] font-semibold text-white [--c:14px]">
                  {M.choose} <Chevron />
                </span>
              </span>
              <input type="file" accept=".csv,.xlsx,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ""; }} />
            </label>
          )}

          {step === "columns" && (
            <div className="flex flex-col gap-5">
              <div className="grid gap-4 md:grid-cols-2">
                {sheets.length > 1 && (
                  <label className="flex flex-col gap-1.5">
                    <span className={mono}>{M.sheet}</span>
                    <Select value={sheet ?? ""} onChange={(e) => file && void load(file, e.target.value)}>
                      {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
                    </Select>
                  </label>
                )}
                <label className="flex flex-col gap-1.5">
                  <span className={mono}>{M.listName}</span>
                  <TextInput value={listName} maxLength={80} readOnly={locked} onChange={(e) => setListName(e.target.value)} />
                </label>
              </div>
              {locked && <p className="m-0 text-base text-[#4a5361]">{M.lockedNote}</p>}
              <ul className="m-0 flex list-none flex-col rounded-2xl border border-[#e3e6ec] bg-surface p-0">
                {grid[0].map((h, i) => (
                  <li key={i} className="k-row grid min-w-0 gap-2 border-b border-[#eef0f3] px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center">
                    <span className="min-w-0 truncate text-base font-semibold" title={h}>{h || `(${i + 1})`}</span>
                    <span className="min-w-0 truncate font-mono text-sm text-[#4a5361]" title={grid[1]?.[i]}>{grid[1]?.[i] ?? ""}</span>
                    <Select aria-label={`${M.columnMaps}: ${h}`} value={mapping[i] ?? ""} onChange={(e) => setColumn(i, (e.target.value || null) as ImportField | null)}>
                      <option value="">{M.ignore}</option>
                      {IMPORT_FIELDS.map((f) => <option key={f} value={f}>{M.fields[f]}</option>)}
                    </Select>
                  </li>
                ))}
              </ul>
              <label className="flex cursor-pointer flex-col gap-1 rounded-[14px] bg-honey-soft px-4 py-3 text-base">
                <span className="flex items-center gap-2.5 font-semibold">
                  <input type="checkbox" checked={training} disabled={locked} onChange={(e) => setTraining(e.target.checked)} className="size-5 accent-ink" />
                  {M.training}
                </span>
                <span className="pl-[30px] text-[#4a5361]">{M.trainingHelp}</span>
              </label>
              {noId && <Notice tone="warn" role="alert">{M.fileErrors.noIdColumn}</Notice>}
              {!listName.trim() && <p className="m-0 text-base text-[#4a5361]">{M.listNameRequired}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <HexButton type="button" disabled={busy || noId || !listName.trim()} onClick={() => void toPreview()}>
                  {busy ? M.previewLoading : M.next} <Chevron className="k-arrow" />
                </HexButton>
                <Button type="button" variant="secondary" onClick={back}>{M.back}</Button>
              </div>
            </div>
          )}

          {step === "preview" && (
            <div className="flex flex-col gap-5">
              <p className="m-0 rounded-[14px] bg-honey-soft px-4 py-3 font-mono text-base" role="status">
                {fill(M.previewCounts, { rows: entries.length, new: previewNew, merged: valid.length - previewNew, errors: errs.length })}
              </p>
              <div className="overflow-x-auto rounded-2xl border border-[#e3e6ec] px-2">
                <table className="w-full border-collapse text-left text-base">
                  <thead>
                    <tr className="border-b-2 border-[#e3e6ec] text-[15px] text-[#4a5361]">
                      <th className="px-2 py-2.5 font-semibold">{M.previewTable.row}</th>
                      <th className="px-2 py-2.5 font-semibold">{M.previewTable.company}</th>
                      <th className="px-2 py-2.5 font-semibold">{M.previewTable.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.slice(0, 20).map((e) => (
                      <tr key={e.row} className="border-b border-[#eef0f3] last:border-b-0">
                        <td className="px-2 py-2 font-mono text-sm">{e.row}</td>
                        <td className="max-w-0 truncate px-2 py-2">{isError(e) ? (e.data.name ?? "") : e.name}</td>
                        <td className={`px-2 py-2 ${isError(e) ? "font-medium text-danger" : ""}`}>{isError(e) ? M.outcomes.error : M.outcomes[outcomes.get(e.row) ?? "new"]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {errs.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-[14px] border-2 border-[#f1b0ab] bg-[#fde8e7] px-4 py-3">
                  <h3 className="m-0 text-base font-semibold text-danger">{M.errorsTitle}</h3>
                  <ul className="m-0 list-none p-0 text-[15px]">
                    {errs.slice(0, 50).map((e) => <li key={e.row}>{rowErrorText(e.row, e.error, t)}</li>)}
                  </ul>
                  {errs.length > 50 && <p className="m-0 text-[15px] text-[#4a5361]">{fill(M.moreErrors, { n: errs.length - 50 })}</p>}
                </div>
              )}
              {busy && <p role="status" className="m-0 font-mono text-base">{fill(M.progress, { done: progress, total: entries.length })}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <HexButton type="button" disabled={busy || entries.length === 0} onClick={() => void run()}>
                  {error && sent > 0 ? M.retry : M.import} <Chevron className="k-arrow" />
                </HexButton>
                <Button type="button" variant="secondary" disabled={busy || sent > 0} onClick={() => setStep("columns")}>{M.back}</Button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="flex flex-col gap-5">
              <p className="m-0 rounded-[14px] bg-ok-soft px-4 py-3 text-lg font-semibold text-ok" role="status">{fill(M.doneCounts, counts)}</p>
              <div className="flex flex-wrap items-center gap-3">
                <HexLink href="/leads">{M.seeLeads} <Chevron className="k-arrow" /></HexLink>
                <Button type="button" variant="secondary" onClick={reset}>{M.another}</Button>
              </div>
              <Link href="/agentes" className="k-link w-fit text-base font-medium underline">{t.qualifier.started}</Link>
            </div>
          )}
        </div>
      </HexPanel>
      <span className="sr-only">{stepIdx + 1}/{STEPS.length}</span>
    </section>
  );
}
