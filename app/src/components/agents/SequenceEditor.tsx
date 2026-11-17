"use client";

import { Notice, Select, TextArea, TextInput } from "@/components/ui";
import { stepProblems, type SequenceStep } from "@/lib/email/template";
import { validDelays } from "@/lib/email/schedule";
import { TONES, type Tone } from "@/lib/email-agent/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

const LABEL = "font-mono text-[13px] font-medium uppercase tracking-wide text-ink";

export type EditorValue = { steps: SequenceStep[]; tone: Tone; step2: string; step3: string };

/** Delays as typed; null while they are not a valid pair. */
export function parseDelays(v: Pick<EditorValue, "step2" | "step3">): { step2: number; step3: number } | null {
  const d = { step2: Number(v.step2), step3: Number(v.step3) };
  return v.step2.trim() !== "" && v.step3.trim() !== "" && validDelays(d) ? d : null;
}

/** Controlled: every value lives in the parent, so a failed save keeps what was typed. Problems show live. */
export function SequenceEditor({ value, onChange, disabled }: { value: EditorValue; onChange: (v: EditorValue) => void; disabled: boolean }) {
  const t = useT();
  const D = t.emailAgent.detail;
  const setStep = (i: number, patch: Partial<SequenceStep>) => onChange({ ...value, steps: value.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const delaysBad = value.steps.length > 1 && !parseDelays(value);
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-base text-[#4a5361]">{D.fields}</p>
      <label className="flex max-w-xs flex-col gap-1.5">
        <span className={LABEL}>{D.tone}</span>
        <Select value={value.tone} disabled={disabled} onChange={(e) => onChange({ ...value, tone: e.target.value as Tone })}>
          {TONES.map((x) => (
            <option key={x} value={x}>
              {t.emailAgent.tones[x]}
            </option>
          ))}
        </Select>
      </label>
      {value.steps.map((s, i) => {
        const problems = stepProblems(s);
        return (
          <fieldset key={s.step} className="m-0 flex min-w-0 flex-col gap-3 rounded-2xl border border-[#e3e6ec] bg-surface px-4 pb-4 pt-1" disabled={disabled}>
            <legend className="rounded-full bg-honey-pill px-3 py-0.5 font-mono text-[13px] uppercase tracking-wide text-ink">{fill(D.stepTitle, { n: s.step })}</legend>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>{D.subject}</span>
              <TextInput value={s.subject} maxLength={150} onChange={(e) => setStep(i, { subject: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>{D.body}</span>
              <TextArea className="min-h-40" value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />
            </label>
            {problems.length > 0 && (
              <ul role="alert" className="m-0 list-none rounded-[14px] border-2 border-[#f0c48f] bg-warn-soft px-4 py-3 text-base text-warn">
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
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>{D.delay2}</span>
            <TextInput inputMode="numeric" value={value.step2} disabled={disabled} onChange={(e) => onChange({ ...value, step2: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>{D.delay3}</span>
            <TextInput inputMode="numeric" value={value.step3} disabled={disabled} onChange={(e) => onChange({ ...value, step3: e.target.value })} />
          </label>
        </div>
      )}
      {delaysBad && (
        <Notice tone="warn" role="alert">
          {D.delaysInvalid}
        </Notice>
      )}
    </div>
  );
}
