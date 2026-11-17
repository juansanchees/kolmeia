"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { recordContactAction } from "@/app/(app)/leads/ligar/[id]/actions";
import { Button, LinkButton, Notice, TextInput } from "@/components/ui";
import { callBackRange, chipLocal, CONTACT_EXTRA_OUTCOMES, CONTACT_OUTCOMES, type ContactOutcome } from "@/lib/calls/call-input";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** Big outcome buttons: navy text on white, honey when picked (never white on honey), red text for "Não ligar mais". */
const tap = "k-btn inline-flex min-h-16 items-center justify-center gap-2 rounded-[14px] border-2 px-3 text-center text-base font-semibold disabled:cursor-not-allowed disabled:opacity-60";
const CHECK = "M5 12l5 5L20 7";

/**
 * "Registrar contato": one tap per contact, an optional one-line note. "Ligar depois" asks the day (default today + 3),
 * "Não ligar mais" asks to confirm (it is forever). `afterSave`: "stay" refreshes and shows what changed (lead modal),
 * "next" opens the next lead of today's list (call screen). "Caixa postal" and "Número errado" sit in a small second row.
 */
export function ContactRecord({ leadId, afterSave }: { leadId: string; afterSave: "stay" | "next" }) {
  const t = useT();
  const C = t.calls;
  const R = t.calls.record;
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pick, setPick] = useState<"talked" | "do_not_call" | null>(null);
  const [day, setDay] = useState(() => chipLocal(3).slice(0, 10));
  const [range] = useState(() => callBackRange());
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
    <div className="flex flex-col gap-4">
      <TextInput aria-label={R.note} placeholder={R.note} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      <div role="group" aria-label={R.title} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {CONTACT_OUTCOMES.map((o) => (
          <button
            key={o}
            type="button"
            disabled={pending}
            aria-pressed={pick === o}
            onClick={() => choose(o)}
            className={`${tap} ${pick === o ? "border-honey bg-honey-light text-ink" : o === "do_not_call" ? "border-line bg-surface text-danger hover:border-danger" : "border-line bg-surface text-ink hover:border-ink"}`}
          >
            {pick === o && (
              <span aria-hidden className="k-pop inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-white">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={CHECK} />
                </svg>
              </span>
            )}
            {R.buttons[o]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
        <span className="text-[#4a5361]">{C.recordMore}</span>
        {CONTACT_EXTRA_OUTCOMES.map((o) => (
          <LinkButton key={o} type="button" disabled={pending} onClick={() => save(o)} className="disabled:opacity-60">
            {R.buttons[o]}
          </LinkButton>
        ))}
      </div>
      {pick === "talked" && (
        <div className="k-fade flex flex-wrap items-end gap-3 rounded-[14px] bg-honey-soft p-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{R.callBackOn}</span>
            <TextInput type="date" value={day} min={range.min} max={range.max} onChange={(e) => setDay(e.target.value)} />
          </label>
          <Button type="button" disabled={pending || !day} onClick={() => save("talked")}>
            {pending ? R.saving : R.save}
          </Button>
        </div>
      )}
      {pick === "do_not_call" && (
        <div className="k-fade flex flex-wrap items-center gap-3 rounded-[14px] border-2 border-[#f1b0ab] bg-[#fde8e7] p-4">
          <p className="m-0 w-full text-base text-danger">{R.dncHint}</p>
          <Button type="button" variant="danger" disabled={pending} onClick={() => save("do_not_call")}>
            {pending ? R.saving : R.confirmDnc}
          </Button>
          <LinkButton type="button" disabled={pending} onClick={() => setPick(null)}>
            {R.cancel}
          </LinkButton>
        </div>
      )}
      {msg && (
        <Notice tone={msg.ok ? "ok" : "danger"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </Notice>
      )}
    </div>
  );
}
