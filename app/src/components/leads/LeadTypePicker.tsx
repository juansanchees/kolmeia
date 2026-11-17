"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setLeadSegmentAction } from "@/app/(app)/leads/lead-actions";
import { SEGMENTS, type Segment } from "@/lib/leads/types";
import { Select } from "@/components/ui";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

export function LeadTypePicker({ leadId, value, derived }: { leadId: string; value: Segment | null; derived: Segment | null }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const auto = derived ? fill(t.leads.segmentPick.auto, { value: t.leads.segments[derived] }) : t.leads.segmentPick.autoNone;

  return (
    <label className="inline-flex flex-col gap-1.5 text-base">
      <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{t.leads.segmentPick.label}</span>
      <Select
        className="w-auto! min-w-56"
        value={value ?? ""}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value as Segment | "";
          start(async () => {
            const r = await setLeadSegmentAction([leadId], v || null);
            setResult({ ok: r.status === "success", message: r.message });
            router.refresh();
          });
        }}
      >
        <option value="">{auto}</option>
        {SEGMENTS.map((s) => (
          <option key={s} value={s}>{t.leads.segments[s]}</option>
        ))}
      </Select>
      {result?.message && (
        <span role={result.ok ? "status" : "alert"} className={result.ok ? "text-ok" : "text-danger"}>{result.message}</span>
      )}
    </label>
  );
}
