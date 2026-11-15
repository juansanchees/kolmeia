"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveC12Item, setClockReal, type C12Item } from "@/app/(app)/campanhas/c12-actions";
import { fill, t } from "@/messages/pt";
import { Badge, btn, Card, CardTitle, input, Notice } from "./bits";

const M = t.email.c12;
const ITEMS = Object.keys(M.items) as C12Item[];

export type C12Approval = { item: string; evidence: string; approved_at: string };

export type ClockReal = { enabled: boolean; setAt: string | null; setBy: string | null };

/** Pure gating of the owner switch: Ligar needs all 7 C12 items and an owner; Desligar only an owner. */
export function clockRealGate({ approved, total, isOwner, enabled }: { approved: number; total: number; isOwner: boolean; enabled: boolean }) {
  const missing = Math.max(0, total - approved);
  return { canTurnOn: isOwner && !enabled && missing === 0, canTurnOff: isOwner && enabled, missing };
}

/** C12 (0018): the owner approves each item by hand with a note; everyone else sees the status only. */
export function C12Checklist({ campaignId, approvals, isOwner, clock, userId }: { campaignId: string; approvals: C12Approval[]; isOwner: boolean; clock: ClockReal; userId: string }) {
  const done = new Map(approvals.map((a) => [a.item, a]));
  const count = ITEMS.filter((i) => done.has(i)).length;
  return (
    <Card aria-labelledby="c12-title">
      <CardTitle id="c12-title">{M.title}</CardTitle>
      <Notice tone={count === ITEMS.length ? "ok" : "warn"}>{count === ITEMS.length ? M.ready : M.blocked}</Notice>
      <p className="m-0 text-[13px] text-muted">
        {fill(M.progress, { n: count })} · {isOwner ? M.intro : M.viewOnly}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {ITEMS.map((item) => (
          <li key={item} className="flex min-w-0 flex-col gap-2 border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-words text-sm font-semibold">{M.items[item]}</span>
              <Badge tone={done.has(item) ? "ok" : "warn"}>{done.has(item) ? "OK" : M.pending}</Badge>
            </div>
            {done.has(item) && (
              <span className="break-words text-[13px] text-muted">
                {fill(M.approvedOn, { date: new Date(done.get(item)!.approved_at).toLocaleDateString("pt-BR"), evidence: done.get(item)!.evidence })}
              </span>
            )}
            {isOwner && <C12ItemForm campaignId={campaignId} item={item} again={done.has(item)} />}
          </li>
        ))}
      </ul>
      <ClockRealSwitch campaignId={campaignId} missing={ITEMS.length - count} total={ITEMS.length} isOwner={isOwner} clock={clock} userId={userId} />
    </Card>
  );
}

function ClockRealSwitch({ campaignId, missing, total, isOwner, clock, userId }: { campaignId: string; missing: number; total: number; isOwner: boolean; clock: ClockReal; userId: string }) {
  const C = M.clock;
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const gate = clockRealGate({ approved: total - missing, total, isOwner, enabled: clock.enabled });
  const date = clock.setAt ? new Date(clock.setAt).toLocaleDateString("pt-BR") : "";
  const who = clock.setBy === userId ? C.you : C.other;
  const state = clock.enabled ? fill(C.stateOn, { date, who }) : clock.setAt ? fill(C.stateOffSince, { date, who }) : C.stateOff;
  const run = (on: boolean) =>
    start(async () => {
      const r = await setClockReal(campaignId, on);
      setMsg({ ok: r.ok, text: r.message });
      setConfirming(false);
      router.refresh();
    });
  return (
    <section aria-labelledby="clock-real-title" className="flex min-w-0 flex-col gap-2 border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="clock-real-title" className="m-0 text-sm font-semibold">
          {C.title}
        </h3>
        <Badge tone={clock.enabled ? "ok" : "warn"}>{clock.enabled ? C.on : C.off}</Badge>
      </div>
      <p className="m-0 break-words text-[13px] text-muted">{state}</p>
      <p className="m-0 break-words text-[13px] text-muted">{C.serverNote}</p>
      {!isOwner && <p className="m-0 text-[13px] text-muted">{C.viewOnly}</p>}
      {isOwner && !clock.enabled && gate.missing > 0 && <Notice tone="warn">{fill(C.needsC12, { n: gate.missing })}</Notice>}
      {isOwner && confirming && (
        <Notice tone="warn">
          <strong>{C.confirmTitle}</strong> {C.confirmBody}
        </Notice>
      )}
      {isOwner && (
        <div className="flex flex-wrap items-center gap-2">
          {!clock.enabled && !confirming && (
            <button type="button" className={btn.ghost} disabled={!gate.canTurnOn || pending} onClick={() => setConfirming(true)}>
              {C.turnOn}
            </button>
          )}
          {!clock.enabled && confirming && (
            <>
              <button type="button" className={btn.ghost} disabled={!gate.canTurnOn || pending} onClick={() => run(true)}>
                {C.confirmYes}
              </button>
              <button type="button" className={btn.ghost} disabled={pending} onClick={() => setConfirming(false)}>
                {C.cancel}
              </button>
            </>
          )}
          {clock.enabled && (
            <button type="button" className={btn.ghost} disabled={!gate.canTurnOff || pending} onClick={() => run(false)}>
              {C.turnOff}
            </button>
          )}
          {msg && (
            <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>
              {msg.text}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function C12ItemForm({ campaignId, item, again }: { campaignId: string; item: C12Item; again: boolean }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!checked) return setMsg({ ok: false, text: M.needConfirm });
        if (evidence.trim().length < 3) return setMsg({ ok: false, text: M.needEvidence });
        start(async () => {
          const r = await approveC12Item(campaignId, item, evidence);
          setMsg({ ok: r.ok, text: r.message });
          if (r.ok) {
            setChecked(false);
            setEvidence("");
          }
          router.refresh();
        });
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="size-4" />
        {M.confirm}
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{M.evidence}</span>
        <input
          type="text"
          required
          minLength={3}
          maxLength={300}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder={M.evidencePlaceholder}
          className={input}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={btn.ghost} disabled={pending}>
          {again ? M.reapprove : M.approve}
        </button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
