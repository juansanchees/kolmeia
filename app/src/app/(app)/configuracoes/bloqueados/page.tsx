import { notFound } from "next/navigation";
import { isSender } from "@/lib/roles";
import { emailSession } from "@/lib/email/session";
import type { SuppressionRow } from "@/lib/email/types";
import { removeSuppression } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, CountPill, EmptyState, HexPanel, StepTitle } from "@/components/ui";
import { SuppressionForm } from "@/components/email/forms";
import { when } from "@/components/email/format";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";

export default async function BlockedPage() {
  const t = await getT();
  const B = t.email.blocked;
  const s = await emailSession();
  if (!s) return null;
  if (!isSender(s.workspace.role)) notFound();
  const { data } = await s.supabase
    .from("suppressions")
    .select("id, kind, value, reason, note, created_at")
    .eq("workspace_id", s.workspace.id)
    .order("created_at", { ascending: false })
    .limit(500);
  const rows = (data ?? []) as SuppressionRow[];
  const isOwner = s.workspace.role === "owner";

  return (
    <div className="flex flex-wrap items-start gap-5">
      <HexPanel as="section" aria-labelledby="bl-list" wrapClassName="k-in flex-[2_1_380px]" className="flex flex-col gap-4 py-6">
        <div id="bl-list" className="flex flex-wrap items-start justify-between gap-2">
          <StepTitle n={1} hint={B.intro}>{B.title}</StepTitle>
          <CountPill tone="soft">{rows.length}</CountPill>
        </div>
        {rows.length === 0 && <EmptyState title={B.none} className="py-6" />}
        <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[14px] border-2 border-line p-3 hover:border-honey-edge hover:bg-[#fffaeb]">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="break-all font-semibold">{r.value}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge>{B.kind[r.kind]}</Badge>
                  <Badge tone={r.reason === "manual" ? "neutral" : "warn"}>{B.reasons[r.reason]}</Badge>
                  <span className="font-mono text-sm text-muted">{when(r.created_at, t.intl)}</span>
                </span>
                {r.note && <span className="text-sm text-muted">{r.note}</span>}
              </span>
              {isOwner && <ActionButton action={removeSuppression.bind(null, r.id)} label={B.remove} variant="link" confirm={B.removeConfirm} />}
            </li>
          ))}
        </Paged>
        {!isOwner && rows.length > 0 && <p className="text-sm text-muted">{B.ownerOnly}</p>}
      </HexPanel>
      <HexPanel as="section" aria-labelledby="bl-add" wrapClassName="k-in flex-[1_1_280px]" className="flex flex-col gap-4 py-6">
        <div id="bl-add"><StepTitle n={2}>{B.add}</StepTitle></div>
        <SuppressionForm />
      </HexPanel>
    </div>
  );
}
