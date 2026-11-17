import Link from "next/link";
import { parseCloserBrief } from "@/lib/email/brief";
import { listLeads } from "@/lib/leads/queries";
import type { Person } from "@/lib/team/types";
import { emailSession } from "@/lib/email/session";
import { PROSPECT_COLUMNS, type ProspectRow } from "@/lib/email/types";
import { refreshBriefAction } from "@/app/(app)/campanhas/actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Badge, buttonClass, EmptyState } from "@/components/ui";
import { BlockTitle, SectionIntro } from "@/components/leads/SectionIntro";
import { when } from "@/components/email/format";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";

const HANDOFF_ICON = "M5 12h14M13 6l6 6-6 6";

export default async function CloserPage() {
  const t = await getT();
  const H = t.handoff;
  const C = t.email.closer;
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

  // Leads handed to a closer (F5): RLS limits the closer to hers; owner/sdr see all and who holds each one.
  const withCloser = (await listLeads(s.supabase, s.workspace.id, { statuses: ["with_closer", "meeting"], ownerNotNull: true }))
    .sort((a, b) => (b.lead.handed_off_at ?? "").localeCompare(a.lead.handed_off_at ?? ""));
  let labels = new Map<string, string>();
  if (s.canSend) {
    const { data: people } = await s.supabase.rpc("list_workspace_people", { p_ws: s.workspace.id });
    labels = new Map(((people ?? []) as Person[]).map((p) => [p.user_id, p.label]));
  }

  const label = "font-mono text-[13px] font-medium uppercase tracking-wide text-[#4a5361]";
  const card = "flex min-w-0 flex-col gap-4 rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] md:p-6";
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionIntro title={C.title} subtitle={H.page.subtitle} />
      {withCloser.length === 0 && <EmptyState icon={HANDOFF_ICON} title={H.noneYet}>{H.page.noneHint}</EmptyState>}
      <Paged as="ul" className="m-0 flex list-none flex-col gap-4 p-0">
        {withCloser.map((i) => {
          const b = parseCloserBrief(i.lead.closer_brief);
          return (
            <li key={i.lead.id} className="k-in">
              <article className={card}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="m-0 min-w-0 break-words font-display text-[26px] uppercase leading-tight tracking-wide">
                    <Link href={`/leads/${i.lead.id}`} className="k-link no-underline hover:underline">
                      {i.display.name}
                    </Link>
                  </h3>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="honey" dot>{t.leads.statuses[i.lead.status]}</Badge>
                    {s.canSend && i.lead.owner_id && labels.get(i.lead.owner_id) ? <Badge>{`${H.assignedTo}: ${labels.get(i.lead.owner_id)}`}</Badge> : null}
                    {i.lead.handed_off_at ? <span className="font-mono text-sm text-[#4a5361]">{fill(H.handedAt, { when: when(i.lead.handed_off_at, t.intl) })}</span> : null}
                  </span>
                </div>
                {b ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1 rounded-[14px] bg-ground px-4 py-3">
                      <span className={label}>{C.who}</span>
                      <p className="m-0 text-base">{b.who}</p>
                    </div>
                    <div className="flex flex-col gap-1 rounded-[14px] bg-ground px-4 py-3">
                      <span className={label}>{C.said}</span>
                      <p className="m-0 text-base">{b.what_they_said}</p>
                    </div>
                    <div className="flex flex-col gap-1 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3">
                      <span className={label}>{C.next}</span>
                      <p className="m-0 text-base font-semibold">{b.next_step}</p>
                    </div>
                  </div>
                ) : (
                  <p className="m-0 text-base text-[#4a5361]">{H.noBrief}</p>
                )}
                {!i.lead.do_not_call && i.display.phone && (
                  <div>
                    <Link href={`/leads/ligar/${i.lead.id}`} className={buttonClass("primary", "sm")}>
                      {H.callNow}
                    </Link>
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </Paged>
      {s.canSend && (
        <section aria-labelledby="closer-email-title" className="mt-2 flex flex-col gap-4">
          <BlockTitle id="closer-email-title" hint={C.intro}>{H.page.emailTitle}</BlockTitle>
          {rows.length === 0 && <p className="m-0 text-base text-[#4a5361]">{C.none}</p>}
          <Paged as="ul" className="m-0 flex list-none flex-col gap-4 p-0">
            {rows.map((p) => {
              // stored jsonb: parsed defensively (bad shape -> "sem resumo"), links filtered (R15)
              const brief = parseCloserBrief(p.closer_brief);
              return (
              <li key={p.id}>
                <article className={card}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="m-0 min-w-0 break-words font-display text-[26px] uppercase leading-tight tracking-wide">{p.company_name}</h3>
                    <span className="font-mono text-sm text-[#4a5361]">{fill(C.handedBy, { when: when(p.handed_off_at, t.intl) })}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 text-base">
                    <span className={label}>{C.contact}</span>
                    <span>{[p.contact_name, p.contact_title].filter(Boolean).join(" · ")}</span>
                    {p.email && <span className="break-all font-mono text-[15px]">{p.email}</span>}
                  </div>
                  {brief ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="flex flex-col gap-1 rounded-[14px] bg-ground px-4 py-3">
                        <span className={label}>{C.who}</span>
                        <p className="m-0 text-base">{brief.who}</p>
                      </div>
                      <div className="flex flex-col gap-1 rounded-[14px] bg-ground px-4 py-3">
                        <span className={label}>{C.said}</span>
                        <p className="m-0 text-base">{brief.what_they_said}</p>
                      </div>
                      <div className="flex flex-col gap-1 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3">
                        <span className={label}>{C.next}</span>
                        <p className="m-0 text-base font-semibold">{brief.next_step}</p>
                      </div>
                      <div className="flex flex-col gap-1 sm:col-span-3">
                        <span className="flex items-center gap-2">
                          <span className={label}>{C.evidence}</span>
                          <Badge tone="honey">{t.ai.suggestion}</Badge>
                        </span>
                        {brief.evidence_urls.map((u) => (
                          <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" className="k-link break-all text-[15px] underline">
                            {u} ↗
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="m-0 text-base text-[#4a5361]">{C.noBrief}</p>
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
          </Paged>
        </section>
      )}
    </div>
  );
}
