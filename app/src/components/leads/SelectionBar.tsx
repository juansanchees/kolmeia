"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLeadSegmentAction, setLeadsStatusAction } from "@/app/(app)/leads/lead-actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Button, CountPill, Select } from "@/components/ui";
import { AddToList } from "@/components/leads/AddToList";
import { EmailTools } from "@/components/leads/EmailTools";
import type { FormState } from "@/lib/form-state";
import { SEGMENTS, type Segment } from "@/lib/leads/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

export type BulkNotice = { ok: boolean; text: string };
const noticeOf = (r: FormState, failed: string): BulkNotice => ({ ok: r.status === "success", text: r.message ?? failed });

/**
 * Shown only while rows are ticked: what can be done to all of them at once. Status and type results go to `onResult`
 * (the table shows them), because a success clears the selection and this bar unmounts with it.
 */
export function SelectionBar({ selected, lists, onOpenQualifier, onResult }: { selected: string[]; lists: { id: string; name: string }[]; onOpenQualifier: () => void; onResult: (n: BulkNotice) => void }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();

  const setSegment = (value: string) =>
    start(async () => {
      onResult(noticeOf(await setLeadSegmentAction(selected, value === "none" ? null : (value as Segment)), t.leads.segmentPick.failed));
    });
  const close = (status: "lost" | "discarded") => async () => {
    onResult(noticeOf(await setLeadsStatusAction(selected, status), t.leads.close.failed));
    // the table shows the result; ActionButton must not show a second copy
    return { ok: true };
  };

  return (
    <div role="region" aria-label={fill(t.leads.toolbar.selected, { n: selected.length })} className="k-in flex flex-wrap items-start gap-2.5 rounded-2xl border-2 border-honey-edge bg-honey-soft p-3.5 shadow-[0_-8px_24px_-12px_rgba(15,27,61,0.35)]">
      <span className="flex min-h-11 items-center gap-2 text-base font-semibold">
        <CountPill tone="honey">{selected.length}</CountPill>
        {fill(t.leads.toolbar.selected, { n: selected.length })}
      </span>
      <AddToList selected={selected} lists={lists} />
      {/* refresh only: EmailTools shows its own result, so the selection (and this bar) stays */}
      <EmailTools selected={selected} onDone={() => router.refresh()} />
      <Button type="button" variant="secondary" size="sm" onClick={onOpenQualifier}>
        {t.spend.qualify.go}
      </Button>
      <Select aria-label={t.leads.segmentPick.bulk} value="" disabled={pending} onChange={(e) => setSegment(e.target.value)} className="w-auto! min-w-48">
          <option value="" disabled>{t.leads.segmentPick.bulk}</option>
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>{t.leads.segments[s]}</option>
          ))}
          <option value="none">{t.leads.segments.none}</option>
      </Select>
      <span className="flex min-h-11 items-center text-base text-[#4a5361]">{t.leads.close.label}</span>
      <ActionButton action={close("lost")} label={t.leads.close.lost} confirm={t.leads.close.confirmLost} />
      <ActionButton action={close("discarded")} label={t.leads.close.discarded} confirm={t.leads.close.confirmDiscarded} />
    </div>
  );
}
