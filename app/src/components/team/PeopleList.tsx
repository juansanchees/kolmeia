"use client";

import { revokeInviteAction, removeMemberAction } from "@/app/(app)/configuracoes/equipe/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge } from "@/components/email/bits";
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
          <li key={p.user_id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-line p-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="break-words font-semibold">{p.label}</span>
              <Badge>{t.team.roles[p.role]}</Badge>
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

      <h3 className="text-xl">{t.team.pending}</h3>
      {invites.length === 0 && <p className="text-sm text-muted">{t.team.noPending}</p>}
      <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
        {invites.map((i) => (
          <li key={i.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-line p-3">
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
