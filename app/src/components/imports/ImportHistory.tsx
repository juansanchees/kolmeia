"use client";

import { useState, useTransition } from "react";
import { undoImportAction } from "@/app/(app)/leads/subir/actions";
import { btn } from "@/components/email/bits";
import { date } from "@/components/research/format";
import type { ImportListItem } from "@/lib/imports/store";
import { fill, t } from "@/messages/pt";

const M = t.imports;

export function ImportHistory({ items }: { items: ImportListItem[] }) {
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
    <section aria-labelledby="import-history" className="flex flex-col gap-3">
      <h2 id="import-history" className="text-2xl">{M.history}</h2>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {items.length === 0 ? (
        <p className="text-sm text-muted">{M.historyEmpty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {items.map((i) => {
            const result = undone[i.id];
            const status = result ? "undone" : i.status;
            return (
              <li key={i.id} id={`import-${i.id}`} className="flex flex-col gap-2 border-b border-line px-3.5 py-3 last:border-b-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold">{i.list_name}</span>
                  <span className="font-mono text-xs text-muted">{date(i.created_at)} · {M.statuses[status]}</span>
                </div>
                <p className="m-0 text-[13px] text-muted">
                  {fill(M.historyCounts, { rows: i.row_count, new: i.new_count, merged: i.merged_count, errors: i.error_count })}
                </p>
                {result && <p role="status" className="m-0 text-[13px]">{fill(M.undoneCounts, result)}</p>}
                {!result && status !== "undone" &&
                  (asking === i.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm">{M.undoConfirm}</span>
                      <button type="button" disabled={pending} onClick={() => undo(i.id)} className={btn.danger}>{M.undoYes}</button>
                      <button type="button" disabled={pending} onClick={() => setAsking(null)} className={btn.ghost}>{M.undoNo}</button>
                    </div>
                  ) : (
                    <div>
                      <button type="button" onClick={() => { setError(null); setAsking(i.id); }} className={btn.ghost}>{M.undo}</button>
                    </div>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
