"use client";

import { revokeInviteAction, removeMemberAction } from "@/app/(app)/configuracoes/equipe/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, EmptyState, StepTitle } from "@/components/ui";
import type { InviteRow, Person } from "@/lib/team/types";
import { useT } from "@/lib/i18n/client";
import { Paged } from "@/components/Pager";

const day = (iso: string, intl: string) => new Date(iso).toLocaleDateString(intl, { timeZone: "America/New_York" });

export function PeopleList({ people, invites }: { people: Person[]; invites: InviteRow[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
        {people.map((p) => (
          <li key={p.user_id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[14px] border-2 border-line p-3 hover:border-honey-edge hover:bg-[#fffaeb]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="break-words font-semibold">{p.label}</span>
              <Badge tone={p.role === "owner" ? "navy" : p.role === "sdr" ? "honey" : "neutral"}>{t.team.roles[p.role]}</Badge>
            </span>
            {p.role !== "owner" && (
              <ActionButton
                variant="danger"
                label={t.team.remove}
                confirm={`${t.team.remove}: ${p.label}?`}
                action={async () => {
                  const r = await removeMemberAction(p.user_id);
                  return { ok: r.status === "success", message: r.message };
                }}
              />
            )}
          </li>
        ))}
      </Paged>

      <StepTitle as="h3" n={3}>{t.team.pending}</StepTitle>
      {invites.length === 0 && <EmptyState title={t.team.noPending} className="py-6">{t.team.noPendingHint}</EmptyState>}
      <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
        {invites.map((i) => (
          <li key={i.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[14px] border-2 border-line p-3 hover:border-honey-edge hover:bg-[#fffaeb]">
            <span className="flex min-w-0 flex-col">
              <span className="break-words font-semibold">{i.name}</span>
              <span className="break-all text-sm">{i.email}</span>
              <span className="text-sm text-muted">{t.team.until} {day(i.expires_at, t.intl)}</span>
            </span>
            <ActionButton
              variant="danger"
              label={t.team.revoke}
              action={async () => {
                await revokeInviteAction(i.id);
                return { ok: true };
              }}
            />
          </li>
        ))}
      </Paged>
    </div>
  );
}
