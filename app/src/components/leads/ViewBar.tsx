"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveViewAction } from "@/app/(app)/leads/view-actions";
import { btn } from "@/components/email/bits";
import type { LeadView } from "@/lib/leads/queries";
import type { LeadFilters } from "@/lib/leads/view";
import { t } from "@/messages/pt";

const V = t.leads.views;

/** "Visão" picker plus "Salvar visão" (name + "open with this view"). */
export function ViewBar({ views, filters, onPick }: { views: LeadView[]; filters: LeadFilters; onPick: (f: LeadFilters | null) => void }) {
  const router = useRouter();
  const [picked, setPicked] = useState(views.find((v) => v.is_default)?.id ?? "");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const r = await saveViewAction(name, filters, makeDefault);
      setMsg(r.message ?? null);
      if (r.ok) {
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wide">{V.label}</span>
        <select
          value={picked}
          onChange={(e) => {
            setPicked(e.target.value);
            onPick(views.find((v) => v.id === e.target.value)?.filters ?? null);
          }}
          className="min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink"
        >
          <option value="">{V.none}</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {open ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-xs uppercase tracking-wide">{V.name}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="min-h-11 border border-line bg-surface px-3 text-sm text-ink" />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="h-4 w-4" />
            {V.makeDefault}
          </label>
          <button type="button" className={btn.ghost} disabled={pending || !name.trim()} onClick={save}>
            {V.save}
          </button>
          <button type="button" className={btn.link} onClick={() => setOpen(false)}>
            {V.cancel}
          </button>
        </div>
      ) : (
        <button type="button" className={btn.ghost} onClick={() => setOpen(true)}>
          {V.save}
        </button>
      )}
      {msg && <span role="status" className="text-sm text-muted">{msg}</span>}
    </div>
  );
}
