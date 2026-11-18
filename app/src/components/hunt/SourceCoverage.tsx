import { Badge, EmptyState, type BadgeTone } from "@/components/ui";
import { date } from "@/components/research/format";
import type { CoverageRow } from "@/lib/kb/coverage";
import { word } from "@/lib/hunt/text";
import { getT } from "@/lib/i18n/server";

export const OUTCOME_TONE: Record<string, BadgeTone> = { ok: "ok", partial: "warn", blocked: "danger", robots: "danger", down: "danger", login: "warn", empty: "neutral", skipped: "neutral" };

/** One row per (town, source): when, what happened, how many came in and why. `rows` is already reduced. */
export async function SourceCoverage({ rows }: { rows: CoverageRow[] }) {
  const t = await getT();
  const C = t.hunt.cov;
  if (rows.length === 0) return <EmptyState title={C.empty} />;
  const sorted = [...rows].sort((a, b) => a.town.localeCompare(b.town) || a.source.localeCompare(b.source));
  return (
    <ul className="m-0 flex list-none flex-col p-0" data-testid="source-coverage">
      {sorted.map((r) => (
        <li key={`${r.town}|${r.source}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#eef0f3] py-3 text-base last:border-b-0">
          <span className="font-semibold">{r.town}</span>
          <span>{word(C.sources, r.source)}</span>
          <span className="font-mono text-sm text-[#4a5361]">{date(r.ran_at, t.intl)}</span>
          <Badge tone={OUTCOME_TONE[r.outcome] ?? "neutral"}>{word(t.hunt.round.outcomes, r.outcome)}</Badge>
          <span className="font-mono text-sm">{C.columns.entered}: {r.rows_in}</span>
          {r.reason && <span className="min-w-0 break-words text-[#4a5361]">{r.reason}</span>}
        </li>
      ))}
    </ul>
  );
}
