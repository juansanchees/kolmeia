"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveViewAction } from "@/app/(app)/leads/view-actions";
import { Button, LinkButton, Select, TextInput } from "@/components/ui";
import type { LeadView } from "@/lib/leads/queries";
import type { LeadFilters } from "@/lib/leads/view";
import { useT } from "@/lib/i18n/client";

/** "Visão" picker plus "Salvar visão" (name + "open with this view"). */
export function ViewBar({ views, filters, onPick }: { views: LeadView[]; filters: LeadFilters; onPick: (f: LeadFilters | null) => void }) {
  const t = useT();
  const V = t.leads.views;
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
    <div className="k-fade flex flex-wrap items-end gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-4 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)]">
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{V.label}</span>
        <Select
          value={picked}
          onChange={(e) => {
            setPicked(e.target.value);
            onPick(views.find((v) => v.id === e.target.value)?.filters ?? null);
          }}
          className="w-auto! min-w-56"
        >
          <option value="">{V.none}</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
      </label>
      {open ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{V.name}</span>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="w-auto! min-w-48" />
          </label>
          <label className="flex min-h-12 items-center gap-2.5 text-base">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="size-5 accent-ink" />
            {V.makeDefault}
          </label>
          <Button type="button" disabled={pending || !name.trim()} onClick={save}>
            {V.save}
          </Button>
          <LinkButton type="button" onClick={() => setOpen(false)}>
            {V.cancel}
          </LinkButton>
        </div>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          {V.save}
        </Button>
      )}
      {msg && <span role="status" className="text-base text-[#4a5361]">{msg}</span>}
    </div>
  );
}
