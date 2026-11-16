"use client";

import { useState, useTransition } from "react";
import { archiveLeadsAction, setLeadSegmentAction, unarchiveLeadsAction } from "@/app/(app)/leads/lead-actions";
import { ActionButton } from "@/components/email/ActionButton";
import { btn } from "@/components/email/bits";
import { AddToList } from "@/components/leads/AddToList";
import { EmailTools } from "@/components/leads/EmailTools";
import type { FormState } from "@/lib/form-state";
import { SEGMENTS, type Segment } from "@/lib/leads/types";
import { fill, t } from "@/messages/pt";

const asResult = (r: FormState) => ({ ok: r.status === "success", message: r.message });

/** Shown only while rows are ticked: what can be done to all of them at once. */
export function SelectionBar({ selected, lists, archivedTab, onOpenQualifier, onDone }: { selected: string[]; lists: { id: string; name: string }[]; archivedTab: boolean; onOpenQualifier: () => void; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const setSegment = (value: string) =>
    start(async () => {
      const r = await setLeadSegmentAction(selected, value === "none" ? null : (value as Segment));
      setMsg(r.message ?? null);
      if (r.status === "success") onDone();
    });
  const archive = async () => {
    const r = asResult(await (archivedTab ? unarchiveLeadsAction(selected) : archiveLeadsAction(selected)));
    if (r.ok) onDone();
    return r;
  };

  return (
    <div role="region" aria-label={fill(t.leads.toolbar.selected, { n: selected.length })} className="flex flex-wrap items-start gap-2 border border-blue bg-blue-wash p-3">
      <span className="flex min-h-11 items-center text-sm font-semibold">{fill(t.leads.toolbar.selected, { n: selected.length })}</span>
      <AddToList selected={selected} lists={lists} />
      <EmailTools selected={selected} onDone={onDone} />
      <button type="button" className={btn.ghost} onClick={onOpenQualifier}>
        {t.spend.qualify.go}
      </button>
      <span className="flex flex-col gap-1">
        <select aria-label={t.leads.segmentPick.bulk} value="" disabled={pending} onChange={(e) => setSegment(e.target.value)} className="min-h-11 min-w-0 border border-edge bg-surface px-2.5 text-[15px] text-ink">
          <option value="" disabled>{t.leads.segmentPick.bulk}</option>
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>{t.leads.segments[s]}</option>
          ))}
          <option value="none">{t.leads.segments.none}</option>
        </select>
        {msg && <span role="status" className="text-sm text-muted">{msg}</span>}
      </span>
      <ActionButton
        action={archive}
        label={archivedTab ? t.leads.archive.unarchive : t.leads.archive.archive}
        confirm={archivedTab ? undefined : t.leads.archive.confirm}
      />
    </div>
  );
}
