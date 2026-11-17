import { CoverageTable } from "@/components/coverage/CoverageTable";
import { ManualMarkForm } from "@/components/coverage/ManualMarkForm";
import { Badge, EmptyState, HexPanel, LinkButton, Notice } from "@/components/ui";
import { BlockTitle, SectionIntro } from "@/components/leads/SectionIntro";
import { date } from "@/components/research/format";
import { loadCoverage } from "@/lib/coverage/queries";
import { coverageTable, placesOf } from "@/lib/coverage/view";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { deleteMarkAction } from "./actions";
import { Paged } from "@/components/Pager";

const LIST_MAX = 50;

// Sender-only. Read-only view of what was searched; the only writes are the manual marks.
export default async function CoveragePage() {
  const t = await getT();
  const C = t.coverage;
  const workspace = await requireSender();
  const db = await createClient();
  if (!db) return <Notice tone="info">{t.ai.notConfigured}</Notice>;
  const data = await loadCoverage(db, workspace.id);
  const table = coverageTable({ searches: data.searches, leadTowns: data.leadTowns, now: new Date() });
  const recent = [...data.searches].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LIST_MAX);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SectionIntro title={C.title} subtitle={C.subtitle} />
      <HexPanel as="section" aria-labelledby="towns-title" c={20} cSm={10} className="flex min-w-0 flex-col gap-4 py-6" wrapClassName="k-in [animation-delay:.15s]">
        <BlockTitle id="towns-title" hint={C.window}>{C.towns}</BlockTitle>
        <p className="m-0 rounded-[14px] bg-honey-soft px-4 py-3 text-lg font-semibold">{fill(C.summary, table.summary)}</p>
        <CoverageTable towns={table.towns} />
      </HexPanel>

      <section aria-labelledby="searches-title" className="k-in rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] flex min-w-0 flex-col gap-4 [animation-delay:.22s]">
        <BlockTitle id="searches-title">{C.searches}</BlockTitle>
        {recent.length === 0 ? (
          <EmptyState title={C.noSearches}>{C.noSearchesHint}</EmptyState>
        ) : (
          <Paged as="ul" className="m-0 flex list-none flex-col p-0">
            {recent.map((s, i) => {
              const place = placesOf(s);
              return (
                <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#eef0f3] py-3 text-base last:border-b-0">
                  <span className="font-mono text-sm text-[#4a5361]">{date(s.at, t.intl)}</span>
                  <Badge tone="honey">{C.kinds[s.kind]}</Badge>
                  <span className="min-w-0 break-words font-semibold">{s.label}</span>
                  <span className="min-w-0 break-words text-[#4a5361]">{s.kind === "import" ? C.imported : s.regionText ?? place.towns.join(", ")}</span>
                  {s.rows !== null && <span className="font-mono text-sm">{fill(C.rowsNew, { rows: s.rows, new: s.newCount ?? 0 })}</span>}
                  {s.rows === null && s.newCount !== null && <span className="font-mono text-sm">{fill(C.found, { n: s.newCount })}</span>}
                  {place.statewide && <Badge>{C.statewide}</Badge>}
                  {place.outside && <Badge>{C.outside}</Badge>}
                </li>
              );
            })}
          </Paged>
        )}
      </section>

      <section aria-labelledby="manual-title" className="k-in rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] flex min-w-0 flex-col gap-4 [animation-delay:.28s]">
        <BlockTitle id="manual-title" hint={C.manualHint}>{C.manual}</BlockTitle>
        <ManualMarkForm />
        {data.marks.length > 0 && (
          <Paged as="ul" className="m-0 flex list-none flex-col p-0">
            {data.marks.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#eef0f3] py-2.5 text-base last:border-b-0">
                <span className="font-mono text-sm text-[#4a5361]">{date(m.searched_at, t.intl)}</span>
                <span className="font-semibold">{m.town}</span>
                <span className="min-w-0 break-words text-[#4a5361]">{m.note}</span>
                <form action={deleteMarkAction.bind(null, m.id)} className="ml-auto">
                  <LinkButton type="submit">{C.form.delete}</LinkButton>
                </form>
              </li>
            ))}
          </Paged>
        )}
      </section>
    </div>
  );
}
