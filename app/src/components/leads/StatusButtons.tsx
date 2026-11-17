"use client";

import { setLeadStatusAction } from "@/app/(app)/leads/lead-actions";
import { ActionButton } from "@/components/email/ActionButton";
import { useT } from "@/lib/i18n/client";

/** Won / lost. Quiet buttons: the only orange button here is "Passar pra closer". */
export function StatusButtons({ leadId }: { leadId: string }) {
  const t = useT();
  const H = t.handoff;
  const run = (status: "won" | "lost") => async () => {
    const r = await setLeadStatusAction(leadId, status);
    return { ok: r.status === "success", message: r.message };
  };
  return (
    <div className="flex flex-wrap items-start gap-2">
      <ActionButton action={run("won")} label={H.won} confirm={H.confirmWon} />
      <ActionButton action={run("lost")} label={H.lost} confirm={H.confirmLost} variant="danger" />
    </div>
  );
}
