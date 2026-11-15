import { parseCloserBrief } from "@/lib/email/brief";
import { emailSession } from "@/lib/email/session";
import { PROSPECT_COLUMNS, type ProspectRow } from "@/lib/email/types";
import { refreshBriefAction } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, Label } from "@/components/email/bits";
import { when } from "@/components/email/format";
import { fill, t } from "@/messages/pt";

const M = t.email;
const C = M.closer;

export default async function CloserPage() {
  const s = await emailSession();
  if (!s) return null;
  // Read as the user: owner/sdr get every hand-off; a closer only those of leads assigned to her (RLS, 0017).
  const { data } = await s.supabase
    .from("email_prospects")
    .select(PROSPECT_COLUMNS)
    .eq("workspace_id", s.workspace.id)
    .eq("status", "handed_off")
    .order("handed_off_at", { ascending: false })
    .limit(100);
  const rows = (data ?? []) as ProspectRow[];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="text-sm">{C.intro}</p>
      {rows.length === 0 && <p className="text-sm text-muted">{C.none}</p>}
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {rows.map((p) => {
          // stored jsonb: parsed defensively (bad shape -> "sem resumo"), links filtered (R15)
          const brief = parseCloserBrief(p.closer_brief);
          return (
          <li key={p.id}>
            <article className="flex min-w-0 flex-col gap-3 border border-ink bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 break-words font-display text-2xl uppercase">{p.company_name}</h3>
                <span className="font-mono text-xs text-muted">{fill(C.handedBy, { when: when(p.handed_off_at) })}</span>
              </div>
              <div className="text-sm">
                <Label>{C.contact}</Label>
                {[p.contact_name, p.contact_title].filter(Boolean).join(" · ")}
                {p.email && <span className="block break-all">{p.email}</span>}
              </div>
              {brief ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label>{C.who}</Label>
                    <p className="m-0 text-sm">{brief.who}</p>
                  </div>
                  <div>
                    <Label>{C.said}</Label>
                    <p className="m-0 text-sm">{brief.what_they_said}</p>
                  </div>
                  <div className="border-l-2 border-blue pl-3">
                    <Label>{C.next}</Label>
                    <p className="m-0 text-sm font-semibold">{brief.next_step}</p>
                  </div>
                  <div className="flex flex-col gap-1 sm:col-span-3">
                    <span className="flex items-center gap-2">
                      <Label>{C.evidence}</Label>
                      <Badge tone="soft">{t.ai.suggestion}</Badge>
                    </span>
                    {brief.evidence_urls.map((u) => (
                      <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[13px] text-blue underline underline-offset-4">
                        {u} ↗
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">{C.noBrief}</p>
              )}
              {s.canSend && (
                <div>
                  <ActionButton action={refreshBriefAction.bind(null, p.id)} label={C.refresh} />
                </div>
              )}
            </article>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
