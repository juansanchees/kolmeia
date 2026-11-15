"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveC12Item, type C12Item } from "@/app/(app)/campanhas/c12-actions";
import { fill, t } from "@/messages/pt";
import { Badge, btn, Card, CardTitle, input, Notice } from "./bits";

const M = t.email.c12;
const ITEMS = Object.keys(M.items) as C12Item[];

export type C12Approval = { item: string; evidence: string; approved_at: string };

/** C12 (0018): the owner approves each item by hand with a note; everyone else sees the status only. */
export function C12Checklist({ campaignId, approvals, isOwner }: { campaignId: string; approvals: C12Approval[]; isOwner: boolean }) {
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
    </Card>
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
