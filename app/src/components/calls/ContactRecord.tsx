"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { recordContactAction } from "@/app/(app)/leads/ligar/[id]/actions";
import { btn, input, Notice } from "@/components/email/bits";
import { chipLocal, CONTACT_OUTCOMES, type ContactOutcome } from "@/lib/calls/call-input";
import { fill, t } from "@/messages/pt";

const C = t.calls;
const R = t.calls.record;
const tap = "inline-flex min-h-11 items-center justify-center border px-2 text-center text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";

/**
 * "Registrar contato": one tap per contact, an optional one-line note. "Ligar depois" asks the day (default today + 3),
 * "Não ligar mais" asks to confirm (it is forever). `afterSave`: "stay" refreshes and shows what changed (lead modal),
 * "next" opens the next lead of today's list (call screen). `canRecord` false keeps only the last message.
 */
export function ContactRecord({ leadId, afterSave, canRecord = true }: { leadId: string; afterSave: "stay" | "next"; canRecord?: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pick, setPick] = useState<"talked" | "do_not_call" | null>(null);
  const [day, setDay] = useState(() => chipLocal(3).slice(0, 10));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const save = (outcome: ContactOutcome) =>
    start(async () => {
      setMsg(null);
      try {
        const r = await recordContactAction({ leadId, outcome, note, callBackOn: outcome === "talked" ? day : null });
        if (r.status !== "success") return setMsg({ ok: false, text: r.message ?? C.errors.failed });
        if (afterSave === "next") return router.push(r.next ? `/leads/ligar/${r.next}` : "/leads/ligar");
        setNote("");
        setPick(null);
        setMsg({ ok: true, text: fill(R.saved, { outcome: R.buttons[outcome], status: r.status_after ? t.leads.statuses[r.status_after] : "" }) });
        router.refresh();
      } catch {
        setMsg({ ok: false, text: C.errors.failed });
      }
    });

  const choose = (o: ContactOutcome) => (o === "talked" || o === "do_not_call" ? setPick(pick === o ? null : o) : save(o));

  return (
    <div className="flex flex-col gap-2">
      {canRecord && (
        <>
          <input aria-label={R.note} placeholder={R.note} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className={input} />
          <div role="group" aria-label={R.title} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {CONTACT_OUTCOMES.map((o) => (
              <button
                key={o}
                type="button"
                disabled={pending}
                aria-pressed={pick === o}
                onClick={() => choose(o)}
                className={`${tap} ${pick === o ? "border-blue bg-blue-wash text-blue-ink" : o === "do_not_call" ? "border-danger bg-surface text-danger hover:bg-warn-soft" : "border-edge bg-surface text-ink hover:border-ink"}`}
              >
                {R.buttons[o]}
              </button>
            ))}
          </div>
          {pick === "talked" && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-sm">
                {R.callBackOn}
                <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={input} />
              </label>
              <button type="button" disabled={pending || !day} onClick={() => save("talked")} className={btn.primary}>
                {pending ? R.saving : R.save}
              </button>
            </div>
          )}
          {pick === "do_not_call" && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="m-0 w-full text-sm text-muted">{R.dncHint}</p>
              <button type="button" disabled={pending} onClick={() => save("do_not_call")} className={btn.danger}>
                {pending ? R.saving : R.confirmDnc}
              </button>
              <button type="button" disabled={pending} onClick={() => setPick(null)} className={btn.link}>
                {R.cancel}
              </button>
            </div>
          )}
        </>
      )}
      {msg && (
        <Notice tone={msg.ok ? "ok" : "warn"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </Notice>
      )}
    </div>
  );
}
