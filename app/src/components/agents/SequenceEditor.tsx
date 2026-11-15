"use client";

import { input, Label } from "@/components/email/bits";
import { stepProblems, type SequenceStep } from "@/lib/email/template";
import { validDelays } from "@/lib/email/schedule";
import { TONES, type Tone } from "@/lib/email-agent/types";
import { fill, t } from "@/messages/pt";

const D = t.emailAgent.detail;

export type EditorValue = { steps: SequenceStep[]; tone: Tone; step2: string; step3: string };

/** Delays as typed; null while they are not a valid pair. */
export function parseDelays(v: Pick<EditorValue, "step2" | "step3">): { step2: number; step3: number } | null {
  const d = { step2: Number(v.step2), step3: Number(v.step3) };
  return v.step2.trim() !== "" && v.step3.trim() !== "" && validDelays(d) ? d : null;
}

/** Controlled: every value lives in the parent, so a failed save keeps what was typed. Problems show live. */
export function SequenceEditor({ value, onChange, disabled }: { value: EditorValue; onChange: (v: EditorValue) => void; disabled: boolean }) {
  const setStep = (i: number, patch: Partial<SequenceStep>) => onChange({ ...value, steps: value.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const delaysBad = value.steps.length > 1 && !parseDelays(value);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{D.fields}</p>
      <label className="flex max-w-xs flex-col gap-1">
        <Label>{D.tone}</Label>
        <select className={input} value={value.tone} disabled={disabled} onChange={(e) => onChange({ ...value, tone: e.target.value as Tone })}>
          {TONES.map((x) => (
            <option key={x} value={x}>
              {t.emailAgent.tones[x]}
            </option>
          ))}
        </select>
      </label>
      {value.steps.map((s, i) => {
        const problems = stepProblems(s);
        return (
          <fieldset key={s.step} className="flex flex-col gap-2 border border-line p-3" disabled={disabled}>
            <legend className="px-1 font-mono text-xs text-muted">{fill(D.stepTitle, { n: s.step })}</legend>
            <label className="flex flex-col gap-1">
              <Label>{D.subject}</Label>
              <input className={input} value={s.subject} maxLength={150} onChange={(e) => setStep(i, { subject: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <Label>{D.body}</Label>
              <textarea className={`${input} min-h-40`} value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />
            </label>
            {problems.length > 0 && (
              <ul role="alert" className="m-0 list-none bg-warn-soft px-3 py-2 text-sm text-warn">
                {problems.map((p) => (
                  <li key={p}>{D.problems[p] ?? D.problemOther}</li>
                ))}
              </ul>
            )}
          </fieldset>
        );
      })}
      {value.steps.length > 1 && (
        <div className="grid max-w-md grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <Label>{D.delay2}</Label>
            <input className={input} inputMode="numeric" value={value.step2} disabled={disabled} onChange={(e) => onChange({ ...value, step2: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <Label>{D.delay3}</Label>
            <input className={input} inputMode="numeric" value={value.step3} disabled={disabled} onChange={(e) => onChange({ ...value, step3: e.target.value })} />
          </label>
        </div>
      )}
      {delaysBad && (
        <p role="alert" className="bg-warn-soft px-3 py-2 text-sm text-warn">
          {D.delaysInvalid}
        </p>
      )}
    </div>
  );
}
