"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { logCallAction } from "@/app/(app)/leads/ligar/[id]/actions";
import { btn, Notice } from "@/components/email/bits";
import { Field, TextArea, TextInput } from "@/components/ui";
import { chipLocal } from "@/lib/calls/call-input";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/calls/types";
import { statusAfterCall } from "@/lib/calls/view";
import type { LeadStatus } from "@/lib/leads/types";
import { fill, t } from "@/messages/pt";

const C = t.calls;

/** One tap on the outcome is enough; the rest is optional. Values stay on screen after an error. */
export function CallForm({ leadId, agentId, status }: { leadId: string; agentId: string | null; status: LeadStatus }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [spokeTo, setSpokeTo] = useState("");
  const [notes, setNotes] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [nextAt, setNextAt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!outcome || pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await logCallAction({ leadId, agentId, outcome, spokeTo, notes, nextStep, nextAt: nextAt || null });
      if (r.status === "success") {
        router.push(r.next ? `/leads/ligar/${r.next}` : "/leads/ligar");
        return;
      }
      setError(r.message ?? C.errors.failed);
    } catch {
      setError(C.errors.failed);
    }
    setPending(false);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 border border-line bg-surface p-4">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 font-mono text-xs uppercase tracking-wide">{C.outcome}</legend>
        <div role="radiogroup" aria-label={C.outcome} className="grid grid-cols-2 gap-2">
          {CALL_OUTCOMES.map((o) => (
            <label key={o} className={`flex min-h-12 cursor-pointer items-center justify-center border px-2 text-center text-[15px] font-medium ${outcome === o ? "border-blue bg-blue text-white" : "border-edge bg-surface hover:border-ink"}`}>
              <input type="radio" name="outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} className="sr-only" />
              {C.outcomes[o]}
            </label>
          ))}
        </div>
        {outcome && (
          <p aria-live="polite" className="text-[13px] font-semibold">
            {fill(C.statusWillBe, { status: t.leads.statuses[statusAfterCall(status, outcome)] })}
          </p>
        )}
      </fieldset>

      <Field label={C.spokeTo} htmlFor="spokeTo">
        <TextInput id="spokeTo" value={spokeTo} maxLength={120} onChange={(e) => setSpokeTo(e.target.value)} />
      </Field>
      <Field label={C.notes} htmlFor="notes">
        <TextArea id="notes" rows={3} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Field label={C.nextStep} htmlFor="nextStep">
        <TextInput id="nextStep" value={nextStep} maxLength={200} onChange={(e) => setNextStep(e.target.value)} />
      </Field>
      <Field label={C.nextAt} htmlFor="nextAt">
        <TextInput id="nextAt" type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn.ghost} onClick={() => setNextAt(chipLocal(1))}>
          {C.quickTomorrow}
        </button>
        <button type="button" className={btn.ghost} onClick={() => setNextAt(chipLocal(7))}>
          {C.quickWeek}
        </button>
        {nextAt && (
          <button type="button" className={btn.link} onClick={() => setNextAt("")}>
            {C.clear}
          </button>
        )}
      </div>

      {error && <Notice tone="warn" role="alert">{error}</Notice>}
      <button type="submit" disabled={!outcome || pending} className={btn.primary}>
        {pending ? C.saving : C.save}
      </button>
    </form>
  );
}
