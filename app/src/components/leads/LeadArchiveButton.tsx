"use client";

import { ActionButton } from "@/components/email/ActionButton";
import { archiveLeadsAction, unarchiveLeadsAction } from "@/app/(app)/leads/lead-actions";
import type { FormState } from "@/lib/form-state";
import { t } from "@/messages/pt";

const asResult = async (p: Promise<FormState>) => {
  const r = await p;
  return { ok: r.status === "success", message: r.message };
};

// One ActionButton instance for both states, so its result message survives the refresh that flips the label.
export function LeadArchiveButton({ leadId, archived }: { leadId: string; archived: boolean }) {
  return archived ? (
    <ActionButton label={t.leads.archive.unarchive} action={() => asResult(unarchiveLeadsAction([leadId]))} />
  ) : (
    <ActionButton label={t.leads.archive.archive} confirm={t.leads.archive.confirm} action={() => asResult(archiveLeadsAction([leadId]))} />
  );
}
