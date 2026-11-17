"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addToListAction } from "@/app/(app)/leads/view-actions";
import { Button, LinkButton, Select, TextInput } from "@/components/ui";
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
        <Button type="button" variant="secondary" size="sm" disabled={selected.length === 0} onClick={() => setOpen(true)}>
          {A.button}
          {selected.length > 0 ? ` (${selected.length})` : ""}
        </Button>
        {msg && <span role="status" className="text-base text-[#4a5361]">{msg}</span>}
      </div>
    );
  }
  return (
    <div role="group" aria-label={fill(A.title, { n: selected.length })} className="k-fade flex flex-wrap items-end gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-4">
      <p className="m-0 w-full text-base font-semibold">{fill(A.title, { n: selected.length })}</p>
      {lists.length > 0 && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{A.existing}</span>
            <Select value={listId} onChange={(e) => setListId(e.target.value)} className="w-auto! min-w-48">
              <option value="">{A.pickOne}</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </label>
          <span className="pb-3 text-base text-[#4a5361]">{A.or}</span>
        </>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{A.newName}</span>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="w-auto! min-w-48" />
      </label>
      <Button type="button" disabled={pending || (!name.trim() && !listId)} onClick={run}>
        {A.confirm}
      </Button>
      <LinkButton type="button" onClick={() => setOpen(false)}>
        {A.cancel}
      </LinkButton>
      {msg && <span role="status" className="text-base text-[#4a5361]">{msg}</span>}
    </div>
  );
}
