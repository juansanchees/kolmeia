import { notFound } from "next/navigation";
import { isSender } from "@/lib/roles";
import { emailSession } from "@/lib/email/session";
import type { SuppressionRow } from "@/lib/email/types";
import { removeSuppression } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, Card, CardTitle } from "@/components/email/bits";
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
      <Card aria-labelledby="bl-list" className="flex-[2_1_380px]">
        <CardTitle id="bl-list">
          {B.title} · {rows.length}
        </CardTitle>
        <p className="text-sm">{B.intro}</p>
        {rows.length === 0 && <p className="text-sm text-muted">{B.none}</p>}
        <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-line p-3">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="break-all font-semibold">{r.value}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge>{B.kind[r.kind]}</Badge>
                  <Badge tone={r.reason === "manual" ? "cold" : "warn"}>{B.reasons[r.reason]}</Badge>
                  <span className="font-mono text-xs text-muted">{when(r.created_at, t.intl)}</span>
                </span>
                {r.note && <span className="text-[13px] text-muted">{r.note}</span>}
              </span>
              {isOwner && <ActionButton action={removeSuppression.bind(null, r.id)} label={B.remove} variant="link" confirm={B.removeConfirm} />}
            </li>
          ))}
        </Paged>
        {!isOwner && rows.length > 0 && <p className="text-[13px] text-muted">{B.ownerOnly}</p>}
      </Card>
      <Card aria-labelledby="bl-add" className="flex-[1_1_280px]">
        <CardTitle id="bl-add">{B.add}</CardTitle>
        <SuppressionForm />
      </Card>
    </div>
  );
}
