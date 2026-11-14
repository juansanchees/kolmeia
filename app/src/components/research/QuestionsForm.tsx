"use client";

import { useState, useTransition } from "react";
import { answerQuestions } from "@/app/(app)/agentes/actions";
import type { Answers, Question } from "@/lib/research/types";
import { t } from "@/messages/pt";
import { Choice, PrimaryButton } from "./controls";

const M = t.research.conversation;

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
    <form onSubmit={submit} className="flex flex-col gap-4">
      {questions.map((q, i) => (
        <fieldset key={q.id} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
          <legend className="mb-2 text-sm font-semibold">
            {i + 1}. {q.text}
          </legend>
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => (
              <Choice key={o} pressed={state[q.id].choices.includes(o)} onClick={() => toggle(q.id, o)}>
                {o}
              </Choice>
            ))}
          </div>
          {q.allowFreeText && (
            <label className="flex flex-col gap-1 font-mono text-xs text-muted">
              {M.freeText}
              <input
                type="text"
                maxLength={500}
                value={state[q.id].text}
                onChange={(e) => setState((s) => ({ ...s, [q.id]: { ...s[q.id], text: e.target.value } }))}
                className="h-11 w-full border border-edge bg-surface px-3 font-body text-[15px] text-ink"
              />
            </label>
          )}
        </fieldset>
      ))}

      <div className="flex flex-col gap-3 border border-[#c9d8f7] bg-surface p-3.5">
        <label className="flex flex-col gap-1.5 font-mono text-xs text-muted">
          {M.regionLabel} · {t.research.newForm.regionHint}
          <input
            type="text"
            maxLength={1000}
            value={regionText}
            disabled={disabled}
            onChange={(e) => setRegionText(e.target.value)}
            className="h-[46px] w-full border border-edge bg-surface px-3 font-body text-[15px] text-ink"
          />
        </label>
        {places.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="font-mono text-xs text-muted">{M.understoodAsShort}</span>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {places.map((p) => (
                <li key={p} className="border border-blue bg-blue-soft px-3 py-2 text-sm font-semibold text-blue-ink">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[13px] text-muted">{M.regionNote}</p>
      </div>

      {!disabled && (
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton type="submit" disabled={pending}>
            {M.sendAnswers}
          </PrimaryButton>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
