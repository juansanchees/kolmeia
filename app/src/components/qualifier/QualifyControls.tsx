"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { estimateQualifyAction, requestQualifyAction } from "@/app/(app)/leads/qualify-actions";
import { btn, Notice } from "@/components/email/bits";
import { usd } from "@/components/research/format";
import { fill, t } from "@/messages/pt";

const Q = t.qualifier;
const S = t.spend.qualify;
const NEXT = [10, 25, 50] as const;

/** The checkbox at the start of a LEADS row (outside the row's link). */
export function RowCheck({ checked, name, onChange }: { checked: boolean; name: string; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 min-w-11 items-center justify-center">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={fill(S.selectRow, { name })} className="h-5 w-5" />
    </label>
  );
}

type Est = { count: number; usd: number; leftTodayUsd: number };

/** Manual qualification: the estimate comes first, the request only after [Confirmar]. */
export function QualifyControls({ filteredIds, selected, onDone }: { filteredIds: string[]; selected: string[]; onDone: () => void }) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [estimate, setEstimate] = useState<Est | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [next, setNext] = useState<(typeof NEXT)[number]>(10);

  const open = (list: string[]) => {
    if (list.length === 0) return setError(S.none);
    setDone(null);
    setError(null);
    setEstimate(null);
    setIds(list);
    start(async () => {
      const r = await estimateQualifyAction(list);
      if (r.ok) setEstimate({ count: r.count, usd: r.usd, leftTodayUsd: r.leftTodayUsd });
      else {
        setError(S.failed);
        setIds(null);
      }
    });
  };
  const cancel = () => {
    setIds(null);
    setEstimate(null);
  };
  const confirm = () => {
    if (!ids) return;
    start(async () => {
      const r = await requestQualifyAction(ids);
      if (r.ok) {
        setDone(fill(S.queued, { n: r.count }));
        cancel();
        onDone();
      } else setError(S.failed);
    });
  };

  const over = estimate !== null && estimate.usd > estimate.leftTodayUsd;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending || selected.length === 0} onClick={() => open(selected)} className={btn.ghost}>
          {S.selected}
          {selected.length > 0 ? ` (${selected.length})` : ""}
        </button>
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <span>{S.next}</span>
            <select value={next} onChange={(e) => setNext(Number(e.target.value) as (typeof NEXT)[number])} className="min-h-11 border border-line bg-surface px-2 text-sm text-ink">
              {NEXT.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>{S.ofFilter}</span>
          </label>
          <button type="button" disabled={pending || filteredIds.length === 0} onClick={() => open(filteredIds.slice(0, next))} className={btn.ghost}>
            {Q.title}
          </button>
        </span>
      </div>
      {error && <Notice tone="warn" role="alert">{error}</Notice>}
      {done && (
        <Notice tone="ok">
          {done}{" "}
          <Link href="/agentes/gastos" className="underline underline-offset-4">
            {Q.seeSpend}
          </Link>
        </Notice>
      )}
      {ids && (
        <section role="dialog" aria-modal="true" aria-labelledby="qualify-title" className="flex flex-col gap-3 border border-ink bg-surface p-4">
          <h3 id="qualify-title" className="text-xl">
            {fill(S.dialogTitle, { n: ids.length })}
          </h3>
          {estimate === null ? (
            <p className="text-sm text-muted">{S.estimating}</p>
          ) : (
            <>
              <p className="font-mono text-sm font-semibold">{fill(Q.estimate, { usd: usd(estimate.usd) })}</p>
              {over && <Notice tone="warn">{fill(Q.overDay, { left: usd(estimate.leftTodayUsd) })}</Notice>}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={cancel} disabled={pending} className={btn.ghost}>
              {S.cancel}
            </button>
            <button type="button" onClick={confirm} disabled={pending || estimate === null} className={btn.primary}>
              {S.confirm}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
