"use client";

import { useRef, useState, useTransition } from "react";
import { archiveQuestionAction, createQuestionAction, enqueueQuestionAction, stepQuestionAction, testQuestionAction } from "@/app/(app)/leads/ai-question-actions";
import { Button, HexPanel, LinkButton, Notice, Select, TextArea } from "@/components/ui";
import { BlockTitle } from "@/components/leads/SectionIntro";
import { usd } from "@/components/research/format";
import { ANSWER_TYPES, answerFilterValues, QUESTION_MAX, QUESTION_SOURCES, RUN_MAX, TEST_LEADS, type AiCell, type AiQuestion, type AnswerType, type QuestionSource } from "@/lib/ai-questions/types";
import type { LeadFilters } from "@/lib/leads/view";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

const LABEL = "font-mono text-[13px] font-medium uppercase tracking-wide";

/** How a cell reads in the list: "Sim", "Não sei", "na fila…", a score or the short text. */
export function answerText(cell: AiCell | undefined, t: Messages): string {
  const A = t.leads.aiQuestion;
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
  const t = useT();
  const A = t.leads.aiQuestion;
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
    <HexPanel as="section" aria-labelledby="ai-q-title" c={20} cSm={10} className="flex flex-col gap-4 py-6" wrapClassName="k-in">
      <BlockTitle id="ai-q-title" as="h3" hint={A.intro}>{A.title}</BlockTitle>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className={LABEL}>{A.column}</span>
          <Select value={f.aiQuestion} onChange={(e) => set({ aiQuestion: e.target.value, aiAnswer: "all" })} className="w-auto! min-w-56 max-w-full">
            <option value="">{A.none}</option>
            {questions.map((x) => (
              <option key={x.id} value={x.id}>{x.question}</option>
            ))}
          </Select>
        </label>
        {q && (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className={LABEL}>{A.filter}</span>
            <Select value={f.aiAnswer} onChange={(e) => set({ aiAnswer: e.target.value })} className="w-auto! min-w-40">
              <option value="all">{A.all}</option>
              {answerFilterValues(q.answer_type).map((v) => (
                <option key={v} value={v}>{(A.answers as Record<string, string>)[v] ?? v}</option>
              ))}
            </Select>
          </label>
        )}
        <Button type="button" variant="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {A.newTitle}
        </Button>
      </div>

      {open && (
        <div className="k-fade flex flex-col gap-4 rounded-[14px] bg-ground p-4">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>{A.question}</span>
            <TextArea value={text} onChange={(e) => setText(e.target.value)} maxLength={QUESTION_MAX} rows={2} placeholder={A.placeholder} />
            <span className="font-mono text-sm text-[#4a5361]">{text.length}/{QUESTION_MAX}</span>
          </label>
          <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
            <legend className={`${LABEL} mb-2`}>{A.answerType}</legend>
            {ANSWER_TYPES.map((x) => (
              <label key={x} className="k-opt flex min-h-11 items-center gap-2 rounded-full border-2 border-line bg-surface px-4 text-base">
                <input type="radio" name="ai-q-type" checked={type === x} onChange={() => setType(x)} className="size-[18px]" />
                {A.types[x]}
              </label>
            ))}
          </fieldset>
          <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
            <legend className={`${LABEL} mb-2`}>{A.sources}</legend>
            {QUESTION_SOURCES.map((x) => (
              <label key={x} className="k-opt flex min-h-11 items-center gap-2 rounded-full border-2 border-line bg-surface px-4 text-base">
                <input type="checkbox" checked={sources.includes(x)} onChange={(e) => setSources((s) => (e.target.checked ? [...s, x] : s.filter((y) => y !== x)))} className="size-[18px]" />
                {A.sourceLabels[x]}
              </label>
            ))}
          </fieldset>
          <p className="m-0 text-[15px] text-[#4a5361]">{A.noWeb}</p>
          <Button type="button" disabled={busy || text.trim().length < 3 || sources.length === 0} onClick={create} className="w-fit">
            {A.create}
          </Button>
        </div>
      )}

      {q && (
        <div className="flex flex-col gap-3 border-t border-[#e3e6ec] pt-4">
          <span className={LABEL}>{A.before}</span>
          <ol className="m-0 flex list-none flex-col gap-2 p-0 text-base">
            {[A.step1, fill(A.estimate, { n: target.length, usd: `US$ ${usd(Math.ceil(target.length * reserveUsd * 100) / 100, t.intl)}` }), A.step3].map((line, n) => (
              <li key={n} className="flex items-start gap-2.5">
                <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-honey-light font-mono text-sm">{n + 1}</span>
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ol>
          {target.length === 0 && <p className="m-0 text-[15px] text-[#4a5361]">{A.noLeads}</p>}
          <div className="flex flex-wrap items-center gap-2.5">
            <Button type="button" variant="secondary" disabled={busy || testIds.length === 0} onClick={test}>
              {fill(A.test, { n: testIds.length || TEST_LEADS })}
            </Button>
            <Button type="button" disabled={busy || target.length === 0} onClick={run}>
              {fill(A.run, { n: target.length })}
            </Button>
            {running && (
              <LinkButton type="button" onClick={() => (cancel.current = true)}>
                {t.spend.qualify.cancel}
              </LinkButton>
            )}
            <LinkButton type="button" disabled={busy} onClick={() => start(async () => { await archiveQuestionAction(q.id); set({ aiQuestion: "", aiAnswer: "all" }); })} className="disabled:opacity-60">
              {A.archive}
            </LinkButton>
          </div>
          {tested.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1.5 rounded-[14px] bg-ground px-4 py-3 text-base">
              {tested.map((x) => (
                <li key={x.leadId}>
                  <span className="font-semibold">{nameOf(x.leadId)}</span>: {answerText({ status: x.answer === null ? "failed" : "done", answer: x.answer, url: null, excerpt: null, label: null }, t)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div aria-live="polite">{msg && <Notice tone={msg.tone}>{msg.text}</Notice>}</div>
    </HexPanel>
  );
}
