import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, type Tone } from "@/components/email/bits";
import { date, usd } from "@/components/research/format";
import { fill, type Messages } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { runStatusLabel, runTitle } from "@/lib/sources/view";
import { Paged } from "@/components/Pager";

export type RunView = {
  id: string;
  kind: "maps" | "apollo" | "contact" | "shovels" | "b2b";
  query: Record<string, unknown>;
  status: string;
  error: string | null;
  found: number | null;
  dropped: number | null;
  cost_usd: number | null;
  reserve_usd: number;
  import_id: string | null;
  created_at: string;
};

const tone = (s: string): Tone => (s === "imported" ? "ok" : s === "failed" || s === "refused" ? "warn" : s === "running" ? "blue" : "cold");
const open = (s: string) => s === "queued" || s === "running";

function cost(r: RunView, t: Messages): string {
  const Q = t.sources.search;
  if (r.kind === "apollo" || r.kind === "shovels" || r.kind === "b2b") return Q.costNone;
  if (open(r.status)) return fill(t.sources.estimate, { usd: usd(r.reserve_usd, t.intl) });
  if (r.status === "refused") return "—";
  return r.cost_usd === null ? Q.costUnknown : `US$ ${usd(r.cost_usd, t.intl)}`;
}

/** The workspace's last searches: status, found/dropped, cost, link to the import (where "Desfazer" lives). */
export async function RunHistory({ runs }: { runs: RunView[] }) {
  const t = await getT();
  const Q = t.sources.search;
  return (
    <section aria-labelledby="run-history" className="flex flex-col gap-3">
      {runs.some((r) => open(r.status)) && <AutoRefresh seconds={15} />}
      <h2 id="run-history" className="text-2xl">{Q.historyTitle}</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-muted">{Q.historyEmpty}</p>
      ) : (
        <Paged as="ul" className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {runs.map((r) => (
            <li key={r.id} className="flex flex-col gap-1.5 border-b border-line px-3.5 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold">
                  {r.kind === "maps" ? Q.kindMaps : r.kind === "shovels" ? Q.kindShovels : r.kind === "b2b" ? Q.kindB2b : Q.kindApollo} · {runTitle(r, t)}
                </span>
                <span className="font-mono text-xs text-muted">{date(r.created_at, t.intl)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <Badge tone={tone(r.status)}>{runStatusLabel(r, t)}</Badge>
                <span className="text-muted">
                  {r.status === "imported" || r.found !== null
                    ? fill(Q.foundDropped, { found: r.found ?? Q.foundUnknown, dropped: r.dropped ?? Q.foundUnknown })
                    : null}
                </span>
                <span className="font-mono text-xs">{cost(r, t)}</span>
              </div>
              {r.import_id && (
                <div>
                  <Link href={`/leads/subir#import-${r.import_id}`} className="text-sm text-blue underline underline-offset-4">
                    {Q.seeImport}
                  </Link>
                </div>
              )}
            </li>
          ))}
        </Paged>
      )}
    </section>
  );
}
