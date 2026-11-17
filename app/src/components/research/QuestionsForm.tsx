"use client";

import { useState, useTransition } from "react";
import { answerQuestions } from "@/app/(app)/agentes/actions";
import type { Answers, Question } from "@/lib/research/types";
import { useT } from "@/lib/i18n/client";
import { Choice, StepSet } from "./controls";
import { buttonClass, TextInput } from "@/components/ui";

export function QuestionsForm({
  runId,
  questions,
  answers,
  region,
  places,
  disabled,
}: {
  runId: string;
  questions: Question[];
  answers: Answers;
  region: string;
  places: string[];
  disabled: boolean;
}) {
  const t = useT();
  const M = t.research.conversation;
  const [state, setState] = useState<Answers>(() =>
    Object.fromEntries(questions.map((q) => [q.id, answers[q.id] ?? { choices: [], text: "" }])),
  );
  const [regionText, setRegionText] = useState(region);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const toggle = (q: string, option: string) =>
    setState((s) => {
      const cur = s[q].choices;
      return { ...s, [q]: { ...s[q], choices: cur.includes(option) ? cur.filter((c) => c !== option) : [...cur, option] } };
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await answerQuestions(runId, state, regionText);
      setError(r.status === "error" ? (r.message ?? null) : null);
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {questions.map((q, i) => (
        <StepSet key={q.id} n={i + 1} title={q.text} disabled={disabled}>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => (
              <Choice key={o} pressed={state[q.id].choices.includes(o)} onClick={() => toggle(q.id, o)}>
                {o}
              </Choice>
            ))}
          </div>
          {q.allowFreeText && (
            <label className="flex flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
              {M.freeText}
              <TextInput
                type="text"
                maxLength={500}
                value={state[q.id].text}
                onChange={(e) => setState((s) => ({ ...s, [q.id]: { ...s[q.id], text: e.target.value } }))}
                className="font-body normal-case tracking-normal"
              />
            </label>
          )}
        </StepSet>
      ))}

      <div className="flex flex-col gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-4">
        <label className="flex flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
          {M.regionLabel} · {t.research.newForm.regionHint}
          <TextInput
            type="text"
            maxLength={1000}
            value={regionText}
            disabled={disabled}
            onChange={(e) => setRegionText(e.target.value)}
            className="font-body normal-case tracking-normal"
          />
        </label>
        {places.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{M.understoodAsShort}</span>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {places.map((p) => (
                <li key={p} className="rounded-full border-2 border-honey bg-honey-light px-4 py-1.5 text-[15px] font-semibold text-ink">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="m-0 text-[15px] text-[#4a5361]">{M.regionNote}</p>
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass("primary")}>
            {M.sendAnswers}
          </button>
          {error && (
            <p role="alert" className="m-0 text-base font-medium text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
