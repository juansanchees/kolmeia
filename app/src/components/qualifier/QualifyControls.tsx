"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { estimateQualifyAction, requestQualifyAction } from "@/app/(app)/leads/qualify-actions";
import { Button, Notice, Select } from "@/components/ui";
import { usd } from "@/components/research/format";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

const NEXT = [10, 25, 50] as const;

/** The checkbox at the start of a LEADS row (outside the row's link). */
export function RowCheck({ checked, name, onChange }: { checked: boolean; name: string; onChange: (v: boolean) => void }) {
  const t = useT();
  const S = t.spend.qualify;
  return (
    <label className="flex min-h-11 min-w-11 items-center justify-center">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={fill(S.selectRow, { name })} className="size-5 accent-ink" />
    </label>
  );
}

type Est = { count: number; usd: number; leftTodayUsd: number };

/** Manual qualification: the estimate comes first, the request only after [Confirmar]. */
export function QualifyControls({ filteredIds, selected, onDone }: { filteredIds: string[]; selected: string[]; onDone: () => void }) {
  const t = useT();
  const Q = t.qualifier;
  const S = t.spend.qualify;
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
    <div className="k-in flex flex-col gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-4 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)]">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" disabled={pending || selected.length === 0} onClick={() => open(selected)}>
          {S.selected}
          {selected.length > 0 ? ` (${selected.length})` : ""}
        </Button>
        <span className="flex flex-wrap items-center gap-2.5 text-base">
          <label className="flex items-center gap-2">
            <span>{S.next}</span>
            <Select value={next} onChange={(e) => setNext(Number(e.target.value) as (typeof NEXT)[number])} className="w-auto!">
              {NEXT.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <span>{S.ofFilter}</span>
          </label>
          <Button type="button" variant="secondary" disabled={pending || filteredIds.length === 0} onClick={() => open(filteredIds.slice(0, next))}>
            {Q.title}
          </Button>
        </span>
      </div>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      {done && (
        <Notice tone="ok">
          {done}{" "}
          <Link href="/agentes/gastos" className="font-medium underline underline-offset-4">
            {Q.seeSpend}
          </Link>
        </Notice>
      )}
      {ids && (
        <section role="dialog" aria-modal="true" aria-labelledby="qualify-title" className="k-fade flex flex-col gap-3 rounded-[14px] border-2 border-ink bg-surface p-4">
          <h3 id="qualify-title" className="text-xl font-semibold">
            {fill(S.dialogTitle, { n: ids.length })}
          </h3>
          {estimate === null ? (
            <p className="m-0 text-base text-[#4a5361]">{S.estimating}</p>
          ) : (
            <>
              <p className="m-0 rounded-[14px] bg-honey-soft px-4 py-3 font-mono text-base font-semibold">{fill(Q.estimate, { usd: usd(estimate.usd, t.intl) })}</p>
              {over && <Notice tone="warn">{fill(Q.overDay, { left: usd(estimate.leftTodayUsd, t.intl) })}</Notice>}
            </>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Button type="button" onClick={confirm} disabled={pending || estimate === null}>
              {S.confirm}
            </Button>
            <Button type="button" variant="secondary" onClick={cancel} disabled={pending}>
              {S.cancel}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
