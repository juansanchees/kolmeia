"use client";

import { useState, useTransition } from "react";
import { undoImportAction } from "@/app/(app)/leads/subir/actions";
import { Badge, Button, LinkButton } from "@/components/ui";
import { BlockTitle } from "@/components/leads/SectionIntro";
import { TrainButton } from "@/components/profile/TrainButton";
import { date } from "@/components/research/format";
import type { ImportListItem } from "@/lib/imports/store";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { Paged } from "@/components/Pager";

/** `profiles`: import id -> its newest learned profile; `trainEstimateUsd`: what one training call can cost at most. */
export function ImportHistory({ items, profiles = {}, trainEstimateUsd = 0 }: { items: ImportListItem[]; profiles?: Record<string, string>; trainEstimateUsd?: number }) {
  const t = useT();
  const M = t.imports;
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState<string | null>(null);
  const [undone, setUndone] = useState<Record<string, { deleted: number; kept: number }>>({});
  const [error, setError] = useState<string | null>(null);

  const undo = (id: string) =>
    start(async () => {
      const r = await undoImportAction(id);
      setAsking(null);
      if (r.ok) {
        setError(null);
        setUndone((u) => ({ ...u, [id]: { deleted: r.deleted, kept: r.kept } }));
      } else setError(r.error);
    });

  return (
    <section aria-labelledby="import-history" className="k-in flex flex-col gap-3 [animation-delay:.3s]">
      <BlockTitle id="import-history">{M.history}</BlockTitle>
      {error && <p role="alert" className="m-0 text-base text-danger">{error}</p>}
      {items.length === 0 ? (
        <p className="m-0 text-base text-[#4a5361]">{M.historyEmpty}</p>
      ) : (
        <Paged as="ul" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {items.map((i) => {
            const result = undone[i.id];
            const status = result ? "undone" : i.status;
            return (
              <li key={i.id} id={`import-${i.id}`} className="flex flex-col gap-2.5 rounded-2xl border border-[#e3e6ec] bg-surface px-4 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[17px] font-semibold">{i.list_name}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm text-[#4a5361]">{date(i.created_at, t.intl)}</span>
                    <Badge tone={status === "done" ? "ok" : status === "undone" ? "neutral" : "honey"}>{M.statuses[status]}</Badge>
                  </span>
                </div>
                <p className="m-0 font-mono text-sm text-[#4a5361]">
                  {fill(M.historyCounts, { rows: i.row_count, new: i.new_count, merged: i.merged_count, errors: i.error_count })}
                </p>
                {i.use_as_training && status === "done" && (
                  <div className="flex flex-wrap items-center gap-3">
                    <TrainButton importId={i.id} estimateUsd={trainEstimateUsd} knownProfileId={profiles[i.id] ?? null} />
                  </div>
                )}
                {result && <p role="status" className="m-0 text-[15px]">{fill(M.undoneCounts, result)}</p>}
                {!result && status !== "undone" &&
                  (asking === i.id ? (
                    <div className="flex flex-wrap items-center gap-2.5 rounded-[14px] border-2 border-[#f1b0ab] bg-[#fde8e7] px-3 py-2.5">
                      <span className="text-base text-danger">{M.undoConfirm}</span>
                      <Button type="button" variant="danger" size="sm" disabled={pending} onClick={() => undo(i.id)}>{M.undoYes}</Button>
                      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setAsking(null)}>{M.undoNo}</Button>
                    </div>
                  ) : (
                    <div>
                      <LinkButton type="button" onClick={() => { setError(null); setAsking(i.id); }}>{M.undo}</LinkButton>
                    </div>
                  ))}
              </li>
            );
          })}
        </Paged>
      )}
    </section>
  );
}
