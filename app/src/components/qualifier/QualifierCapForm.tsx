"use client";

import { useState, useTransition } from "react";
import { setQualifierAction } from "@/app/(app)/agentes/qualifier-actions";
import { btn, Notice } from "@/components/email/bits";
import type { QualifierStatus } from "@/lib/qualifier/view";
import { useT } from "@/lib/i18n/client";

const input = "min-h-11 w-32 border border-line bg-surface px-3 text-sm text-ink";

/** "5,5" and "5.5" both work; anything else is null. */
function parseUsd(v: string): number | null {
  const s = v.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Number(s);
}

/** Daily cap, lead cap and the automatic deep check. Owner/SDR only: the page requires a sender and the database checks again. */
export function QualifierCapForm({ status }: { status: Pick<QualifierStatus, "daily_cap_usd" | "lead_cap_usd" | "auto_deep"> }) {
  const t = useT();
  const C = t.spend.caps;
  const [daily, setDaily] = useState(String(status.daily_cap_usd));
  const [lead, setLead] = useState(String(status.lead_cap_usd));
  const [autoDeep, setAutoDeep] = useState(status.auto_deep);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const d = parseUsd(daily);
    const l = parseUsd(lead);
    if (d === null || l === null || d > 100 || l < 0.05 || l > 5) {
      setMsg({ tone: "warn", text: C.invalid });
      return;
    }
    start(async () => {
      setMsg(null);
      const r = await setQualifierAction({ daily_cap_usd: d, lead_cap_usd: l, auto_deep: autoDeep });
      setMsg(r.status === "success" ? { tone: "ok", text: C.saved } : { tone: "warn", text: r.message ?? t.qualifier.errors.failed });
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border border-line bg-surface p-4" aria-labelledby="caps-title">
      <h2 id="caps-title" className="text-2xl">
        {C.title}
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {C.daily}
          <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {C.lead}
          <input inputMode="decimal" value={lead} onChange={(e) => setLead(e.target.value)} className={input} />
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={autoDeep} onChange={(e) => setAutoDeep(e.target.checked)} className="h-5 w-5" />
        {C.autoDeep}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={btn.primary}>
          {C.save}
        </button>
        {msg && <Notice tone={msg.tone} role={msg.tone === "warn" ? "alert" : "status"}>{msg.text}</Notice>}
      </div>
    </form>
  );
}
