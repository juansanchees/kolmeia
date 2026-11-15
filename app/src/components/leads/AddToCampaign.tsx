"use client";

import { useState, useTransition } from "react";
import { addLeadsToCampaignAction } from "@/app/(app)/leads/campaign-actions";
import { btn } from "@/components/email/bits";
import { Field } from "@/components/ui";
import { joinsApprovedSequence, type CampaignChoice } from "@/lib/leads/campaign-note";
import { fill, t } from "@/messages/pt";

const C = t.leads.campaign;
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
  const open = campaigns.filter((c) => c.status !== "archived");
  const [campaignId, setCampaignId] = useState(open[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: true; counts: Record<string, number> } | { ok: false; error: string } | null>(null);
  const chosen = open.find((c) => c.id === campaignId);
  const enters = joinsApprovedSequence(chosen);
  if (open.length === 0) return <p className="text-sm text-muted">{C.none}</p>;
  const lines = result?.ok ? LINES.filter(([k]) => (result.counts[k] ?? 0) > 0).map(([k, m]) => fill(C[m], { n: result.counts[k] })) : [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={C.pick} htmlFor="add-campaign">
          <select id="add-campaign" value={campaignId} onChange={(e) => {
              setCampaignId(e.target.value);
              setConfirmed(false);
            }} className="min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink">
            {open.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <button type="button" className={btn.ghost} disabled={pending || !campaignId || (enters && !confirmed)} onClick={() => start(async () => setResult(await addLeadsToCampaignAction(campaignId, leadIds)))}>
          {pending ? `${C.button}…` : C.button}
        </button>
      </div>
      {enters ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="bg-warn-soft px-3 py-2 text-sm text-warn">
            {chosen?.sendMode === "real" ? C.noteReal : C.noteDry}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {C.confirm}
          </label>
        </div>
      ) : (
        <p className="text-[13px] text-muted">{C.note}</p>
      )}
      {result && !result.ok && (
        <p role="alert" className="text-sm text-danger">
          {result.error}
        </p>
      )}
      {result?.ok && (
        <p role="status" className="text-sm text-ink">
          {lines.length > 0 ? lines.join(" · ") : fill(C.added, { n: 0 })}
        </p>
      )}
    </div>
  );
}
