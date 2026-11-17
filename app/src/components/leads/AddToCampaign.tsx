"use client";

import { useState, useTransition } from "react";
import { addLeadsToCampaignAction } from "@/app/(app)/leads/campaign-actions";
import { Button, Field, Notice, Select } from "@/components/ui";
import { joinsApprovedSequence, type CampaignChoice } from "@/lib/leads/campaign-note";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

// Count key from add_leads_to_campaign -> message key.
const LINES = [
  ["added", "added"],
  ["no_email", "noEmail"],
  ["in_other_campaign", "otherCampaign"],
  ["blocked", "blocked"],
  ["suppressed", "suppressed"],
  ["already", "already"],
] as const;

/** Adds leads to one non-archived campaign and shows what happened to each. Never sends. */
export function AddToCampaign({ leadIds, campaigns }: { leadIds: string[]; campaigns: CampaignChoice[] }) {
  const t = useT();
  const C = t.leads.campaign;
  const open = campaigns.filter((c) => c.status !== "archived");
  const [campaignId, setCampaignId] = useState(open[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: true; counts: Record<string, number> } | { ok: false; error: string } | null>(null);
  const chosen = open.find((c) => c.id === campaignId);
  const enters = joinsApprovedSequence(chosen);
  if (open.length === 0) return <p className="m-0 text-base text-[#4a5361]">{C.none}</p>;
  const lines = result?.ok ? LINES.filter(([k]) => (result.counts[k] ?? 0) > 0).map(([k, m]) => fill(C[m], { n: result.counts[k] })) : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={C.pick} htmlFor="add-campaign">
          <Select id="add-campaign" value={campaignId} onChange={(e) => {
              setCampaignId(e.target.value);
              setConfirmed(false);
            }} className="w-auto! min-w-56">
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="button" variant="secondary" disabled={pending || !campaignId || (enters && !confirmed)} onClick={() => start(async () => setResult(await addLeadsToCampaignAction(campaignId, leadIds)))}>
          {pending ? `${C.button}…` : C.button}
        </Button>
      </div>
      {enters ? (
        <div className="flex flex-col gap-2">
          <Notice tone="warn">
            {chosen?.sendMode === "real" ? C.noteReal : C.noteDry}
          </Notice>
          <label className="flex min-h-11 items-center gap-2.5 text-base">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="size-5 accent-ink" />
            {C.confirm}
          </label>
        </div>
      ) : (
        <p className="m-0 text-[15px] text-[#4a5361]">{C.note}</p>
      )}
      {result && !result.ok && (
        <p role="alert" className="m-0 text-base text-danger">
          {result.error}
        </p>
      )}
      {result?.ok && (
        <p role="status" className="m-0 text-base font-medium text-ink">
          {lines.length > 0 ? lines.join(" · ") : fill(C.added, { n: 0 })}
        </p>
      )}
    </div>
  );
}
