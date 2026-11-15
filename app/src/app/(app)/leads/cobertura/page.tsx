import { CoverageTable } from "@/components/coverage/CoverageTable";
import { ManualMarkForm } from "@/components/coverage/ManualMarkForm";
import { Badge, btn, Card, CardTitle, Notice } from "@/components/email/bits";
import { date } from "@/components/research/format";
import { loadCoverage } from "@/lib/coverage/queries";
import { coverageTable, placesOf } from "@/lib/coverage/view";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill, t } from "@/messages/pt";
import { deleteMarkAction } from "./actions";

const C = t.coverage;
const LIST_MAX = 50;

// Sender-only. Read-only view of what was searched; the only writes are the manual marks.
export default async function CoveragePage() {
  const workspace = await requireSender();
  const db = await createClient();
  if (!db) return <Notice tone="info">{t.ai.notConfigured}</Notice>;
  const data = await loadCoverage(db, workspace.id);
  const table = coverageTable({ searches: data.searches, leadTowns: data.leadTowns, now: new Date() });
  const recent = [...data.searches].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LIST_MAX);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card aria-labelledby="searches-title">
        <CardTitle id="searches-title">{C.searches}</CardTitle>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">{C.noSearches}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {recent.map((s, i) => {
              const place = placesOf(s);
              return (
                <li key={i} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line pb-2 text-sm">
                  <span className="font-mono text-xs text-muted">{date(s.at)}</span>
                  <Badge tone="soft">{C.kinds[s.kind]}</Badge>
                  <span className="min-w-0 break-words font-medium">{s.label}</span>
                  <span className="min-w-0 break-words text-muted">{s.kind === "import" ? C.imported : s.regionText ?? place.towns.join(", ")}</span>
                  {s.rows !== null && <span className="font-mono text-xs">{fill(C.rowsNew, { rows: s.rows, new: s.newCount ?? 0 })}</span>}
                  {s.rows === null && s.newCount !== null && <span className="font-mono text-xs">{fill(C.found, { n: s.newCount })}</span>}
                  {place.statewide && <Badge tone="cold">{C.statewide}</Badge>}
                  {place.outside && <Badge tone="cold">{C.outside}</Badge>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card aria-labelledby="towns-title">
        <CardTitle id="towns-title">{C.towns}</CardTitle>
        <p className="text-sm">{fill(C.summary, table.summary)}</p>
        <p className="text-sm text-muted">{C.window}</p>
        <CoverageTable towns={table.towns} />
      </Card>

      <Card aria-labelledby="manual-title">
        <CardTitle id="manual-title">{C.manual}</CardTitle>
        <ManualMarkForm />
        {data.marks.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {data.marks.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono text-xs text-muted">{date(m.searched_at)}</span>
                <span className="font-medium">{m.town}</span>
                <span className="min-w-0 break-words text-muted">{m.note}</span>
                <form action={deleteMarkAction.bind(null, m.id)}>
                  <button type="submit" className={btn.link}>{C.form.delete}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
