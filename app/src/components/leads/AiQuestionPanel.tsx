"use client";

import { useRef, useState, useTransition } from "react";
import { archiveQuestionAction, createQuestionAction, enqueueQuestionAction, stepQuestionAction, testQuestionAction } from "@/app/(app)/leads/ai-question-actions";
import { btn, Notice } from "@/components/email/bits";
import { usd } from "@/components/research/format";
import { ANSWER_TYPES, answerFilterValues, QUESTION_MAX, QUESTION_SOURCES, RUN_MAX, TEST_LEADS, type AiCell, type AiQuestion, type AnswerType, type QuestionSource } from "@/lib/ai-questions/types";
import type { LeadFilters } from "@/lib/leads/view";
import { fill, t } from "@/messages/pt";

const A = t.leads.aiQuestion;
const selectCls = "min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink";

/** How a cell reads in the list: "Sim", "Não sei", "na fila…", a score or the short text. */
export function answerText(cell: AiCell | undefined): string {
  if (!cell || cell.status === "queued") return A.answers.pending;
  if (cell.status !== "done" || cell.answer === null) return A.answers.failed;
  const own = A.answers as Record<string, string>;
  return Object.hasOwn(own, cell.answer) ? own[cell.answer] : cell.answer;
}

type Props = {
  questions: AiQuestion[];
  f: LeadFilters;
  set: (patch: Partial<LeadFilters>) => void;
  selected: string[];
  filtered: string[];
  /** Worst-case cost of one answer (the gateway's reservation), for the estimate shown before a run. */
  reserveUsd: number;
  nameOf: (leadId: string) => string;
  onDone: () => void;
};

/** "Pergunta da IA para cada lead": pick the column, create a question, test on 3, run on N (stops at the AI caps). */
export function AiQuestionPanel({ questions, f, set, selected, filtered, reserveUsd, nameOf, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [type, setType] = useState<AnswerType>("yes_no_unknown");
  const [sources, setSources] = useState<QuestionSource[]>(["site", "data"]);
  const [msg, setMsg] = useState<{ tone: "warn" | "ok" | "info"; text: string } | null>(null);
  const [tested, setTested] = useState<{ leadId: string; answer: string | null }[]>([]);
  const [pending, start] = useTransition();
  const [running, setRunning] = useState(false);
  const cancel = useRef(false);

  const q = questions.find((x) => x.id === f.aiQuestion) ?? null;
  const target = (selected.length ? selected : filtered).slice(0, RUN_MAX);
  const testIds = target.slice(0, TEST_LEADS);

  const create = () =>
    start(async () => {
      const r = await createQuestionAction({ question: text, answerType: type, sources });
      if (!r.ok) return setMsg({ tone: "warn", text: r.error });
      setText("");
      setOpen(false);
      setMsg(null);
      set({ aiQuestion: r.id, aiAnswer: "all" });
    });

  const test = () =>
    q &&
    start(async () => {
      setMsg(null);
      const r = await testQuestionAction(q.id, testIds);
      if (!r.ok) return setMsg({ tone: "warn", text: r.error });
      setTested(r.result.answers);
      if (r.stopText) setMsg({ tone: "warn", text: fill(A.stopped, { reason: r.stopText }) });
      onDone();
    });

  const run = async () => {
    if (!q || target.length === 0) return;
    setTested([]);
    setRunning(true);
    cancel.current = false;
    const e = await enqueueQuestionAction(q.id, target);
    if (!e.ok) {
      setRunning(false);
      return setMsg({ tone: "warn", text: e.error ?? A.failed });
    }
    let done = 0;
    while (!cancel.current) {
      const r = await stepQuestionAction(q.id);
      if (!r.ok) {
        setMsg({ tone: "warn", text: r.error });
        break;
      }
      done += r.result.done;
      if (r.stopText) {
        setMsg({ tone: "warn", text: fill(A.stopped, { reason: r.stopText }) });
        break;
      }
      // nothing claimable (another tab holds the rest) or nothing left: stop asking
      if (r.result.remaining === 0 || r.result.done === 0) {
        setMsg({ tone: "ok", text: fill(A.finished, { n: done }) });
        break;
      }
      setMsg({ tone: "info", text: fill(A.running, { n: r.result.remaining }) });
    }
    setRunning(false);
    onDone();
  };

  const busy = pending || running;
  return (
    <section aria-labelledby="ai-q-title" className="flex flex-col gap-3 border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-end gap-2">
        <h3 id="ai-q-title" className="m-0 mr-auto text-base">{A.title}</h3>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-xs text-muted">{A.column}</span>
          <select value={f.aiQuestion} onChange={(e) => set({ aiQuestion: e.target.value, aiAnswer: "all" })} className={selectCls}>
            <option value="">{A.none}</option>
            {questions.map((x) => (
              <option key={x.id} value={x.id}>{x.question}</option>
            ))}
          </select>
        </label>
        {q && (
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs text-muted">{A.filter}</span>
            <select value={f.aiAnswer} onChange={(e) => set({ aiAnswer: e.target.value })} className={selectCls}>
              <option value="all">{A.all}</option>
              {answerFilterValues(q.answer_type).map((v) => (
                <option key={v} value={v}>{(A.answers as Record<string, string>)[v] ?? v}</option>
              ))}
            </select>
          </label>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={btn.ghost}>
          {A.newTitle}
        </button>
      </div>
      <p className="m-0 text-[13px] text-muted">{A.intro}</p>

      {open && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs text-muted">{A.question}</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={QUESTION_MAX} rows={2} placeholder={A.placeholder} className="border border-line bg-surface px-3 py-2 text-sm text-ink" />
            <span className="font-mono text-xs text-muted">{text.length}/{QUESTION_MAX}</span>
          </label>
          <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
            <legend className="mb-1 font-mono text-xs text-muted">{A.answerType}</legend>
            {ANSWER_TYPES.map((x) => (
              <label key={x} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="ai-q-type" checked={type === x} onChange={() => setType(x)} />
                {A.types[x]}
              </label>
            ))}
          </fieldset>
          <fieldset className="m-0 flex flex-wrap gap-3 border-0 p-0">
            <legend className="mb-1 font-mono text-xs text-muted">{A.sources}</legend>
            {QUESTION_SOURCES.map((x) => (
              <label key={x} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={sources.includes(x)} onChange={(e) => setSources((s) => (e.target.checked ? [...s, x] : s.filter((y) => y !== x)))} />
                {A.sourceLabels[x]}
              </label>
            ))}
          </fieldset>
          <p className="m-0 text-[13px] text-muted">{A.noWeb}</p>
          <button type="button" disabled={busy || text.trim().length < 3 || sources.length === 0} onClick={create} className={`${btn.primary} w-fit`}>
            {A.create}
          </button>
        </div>
      )}

      {q && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="font-mono text-xs text-muted">{A.before}</span>
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            <li>{A.step1}</li>
            <li>{fill(A.estimate, { n: target.length, usd: `US$ ${usd(Math.ceil(target.length * reserveUsd * 100) / 100)}` })}</li>
            <li>{A.step3}</li>
          </ol>
          {target.length === 0 && <p className="m-0 text-[13px] text-muted">{A.noLeads}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || testIds.length === 0} onClick={test} className={btn.ghost}>
              {fill(A.test, { n: testIds.length || TEST_LEADS })}
            </button>
            <button type="button" disabled={busy || target.length === 0} onClick={run} className={btn.ghost}>
              {fill(A.run, { n: target.length })}
            </button>
            {running && (
              <button type="button" onClick={() => (cancel.current = true)} className={btn.link}>
                {t.spend.qualify.cancel}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => start(async () => { await archiveQuestionAction(q.id); set({ aiQuestion: "", aiAnswer: "all" }); })} className={btn.link}>
              {A.archive}
            </button>
          </div>
          {tested.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {tested.map((x) => (
                <li key={x.leadId}>
                  <span className="font-semibold">{nameOf(x.leadId)}</span>: {answerText({ status: x.answer === null ? "failed" : "done", answer: x.answer, url: null, excerpt: null, label: null })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div aria-live="polite">{msg && <Notice tone={msg.tone}>{msg.text}</Notice>}</div>
    </section>
  );
}
