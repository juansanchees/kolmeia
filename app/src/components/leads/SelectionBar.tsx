"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { archiveLeadsAction, setLeadSegmentAction, unarchiveLeadsAction } from "@/app/(app)/leads/lead-actions";
import { ActionButton } from "@/components/email/ActionButton";
import { btn } from "@/components/email/bits";
import { AddToList } from "@/components/leads/AddToList";
import { EmailTools } from "@/components/leads/EmailTools";
import type { FormState } from "@/lib/form-state";
import { SEGMENTS, type Segment } from "@/lib/leads/types";
import { fill, t } from "@/messages/pt";

export type BulkNotice = { ok: boolean; text: string };
const noticeOf = (r: FormState, failed: string): BulkNotice => ({ ok: r.status === "success", text: r.message ?? failed });

/**
 * Shown only while rows are ticked: what can be done to all of them at once. Archive and type results go to `onResult`
 * (the table shows them), because a success clears the selection and this bar unmounts with it.
 */
export function SelectionBar({ selected, lists, archivedTab, onOpenQualifier, onResult }: { selected: string[]; lists: { id: string; name: string }[]; archivedTab: boolean; onOpenQualifier: () => void; onResult: (n: BulkNotice) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const setSegment = (value: string) =>
    start(async () => {
      onResult(noticeOf(await setLeadSegmentAction(selected, value === "none" ? null : (value as Segment)), t.leads.segmentPick.failed));
    });
  const archive = async () => {
    onResult(noticeOf(await (archivedTab ? unarchiveLeadsAction(selected) : archiveLeadsAction(selected)), t.leads.archive.failed));
    // the table shows the result; ActionButton must not show a second copy
    return { ok: true };
  };

  return (
    <div role="region" aria-label={fill(t.leads.toolbar.selected, { n: selected.length })} className="flex flex-wrap items-start gap-2 border border-blue bg-blue-wash p-3">
      <span className="flex min-h-11 items-center text-sm font-semibold">{fill(t.leads.toolbar.selected, { n: selected.length })}</span>
      <AddToList selected={selected} lists={lists} />
      {/* refresh only: EmailTools shows its own result, so the selection (and this bar) stays */}
      <EmailTools selected={selected} onDone={() => router.refresh()} />
      <button type="button" className={btn.ghost} onClick={onOpenQualifier}>
        {t.spend.qualify.go}
      </button>
      <select aria-label={t.leads.segmentPick.bulk} value="" disabled={pending} onChange={(e) => setSegment(e.target.value)} className="min-h-11 min-w-0 border border-edge bg-surface px-2.5 text-[15px] text-ink">
          <option value="" disabled>{t.leads.segmentPick.bulk}</option>
          {SEGMENTS.map((s) => (
            <option key={s} value={s}>{t.leads.segments[s]}</option>
          ))}
          <option value="none">{t.leads.segments.none}</option>
      </select>
      <ActionButton
        action={archive}
        label={archivedTab ? t.leads.archive.unarchive : t.leads.archive.archive}
        confirm={archivedTab ? undefined : t.leads.archive.confirm}
      />
    </div>
  );
}
