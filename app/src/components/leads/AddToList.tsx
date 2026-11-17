"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addToListAction } from "@/app/(app)/leads/view-actions";
import { btn } from "@/components/email/bits";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** "Adicionar à lista" for the ticked leads: an existing list, or a new name. */
export function AddToList({ selected, lists }: { selected: string[]; lists: { id: string; name: string }[] }) {
  const t = useT();
  const A = t.lists.add;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [listId, setListId] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      const r = await addToListAction(selected, name.trim() ? { name: name.trim() } : { listId });
      setMsg(r.message ?? null);
      if (r.ok) {
        setOpen(false);
        setName("");
        router.refresh();
      }
    });

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn.ghost} disabled={selected.length === 0} onClick={() => setOpen(true)}>
          {A.button}
          {selected.length > 0 ? ` (${selected.length})` : ""}
        </button>
        {msg && <span role="status" className="text-sm text-muted">{msg}</span>}
      </div>
    );
  }
  return (
    <div role="group" aria-label={fill(A.title, { n: selected.length })} className="flex flex-wrap items-end gap-2 border border-line bg-surface p-3">
      <p className="w-full text-sm font-semibold">{fill(A.title, { n: selected.length })}</p>
      {lists.length > 0 && (
        <>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wide">{A.existing}</span>
            <select value={listId} onChange={(e) => setListId(e.target.value)} className="min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink">
              <option value="">{A.pickOne}</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <span className="pb-3 text-sm text-muted">{A.or}</span>
        </>
      )}
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wide">{A.newName}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="min-h-11 border border-line bg-surface px-3 text-sm text-ink" />
      </label>
      <button type="button" className={btn.ghost} disabled={pending || (!name.trim() && !listId)} onClick={run}>
        {A.confirm}
      </button>
      <button type="button" className={btn.link} onClick={() => setOpen(false)}>
        {A.cancel}
      </button>
      {msg && <span role="status" className="text-sm text-muted">{msg}</span>}
    </div>
  );
}
