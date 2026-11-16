import Link from "next/link";
import { Badge } from "@/components/email/bits";
import { usd } from "@/components/research/format";
import type { SourceRow, SpendBy, SpendRow } from "@/lib/spend/view";
import { t } from "@/messages/pt";
import { Paged } from "@/components/Pager";

const S = t.spend;

/** Small costs keep their fractions of a cent: nothing rounds down to "0,00". */
export function money(v: number): string {
  return v > 0 && v < 0.01 ? new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(v) : usd(v);
}

/** One row per group; open a row to see the leads behind it with their cost. */
export function SpendTable({ rows, by }: { rows: SpendRow[]; by: SpendBy }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{S.empty}</p>;
  return (
    <Paged as="ul" resetKey={by} className="m-0 flex list-none flex-col border border-line bg-surface p-0">
      {rows.map((r) => (
        <li key={r.key} className="border-b border-line last:border-b-0">
          <details>
            <summary className="grid min-h-11 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3.5 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto]">
              <span className="min-w-0 truncate text-sm font-semibold">{r.label}</span>
              <span className="text-right font-mono text-sm font-semibold md:order-last">US$ {money(r.usd)}</span>
              <span className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] text-muted md:contents">
                <span className="truncate">{by !== "agent" && r.agent}</span>
                <span className="truncate">{by !== "step" && r.step}</span>
                <span className="truncate">{by !== "model" && r.model}</span>
                <span className="font-mono">
                  {r.inputTokens}/{r.outputTokens}
                  {r.searches + r.fetches > 0 ? ` · ${r.searches}/${r.fetches}` : ""}
                </span>
              </span>
            </summary>
            <div className="flex flex-col gap-1 border-t border-line bg-ground px-3.5 py-3">
              <span className="font-mono text-xs text-muted">{S.leadsOf}</span>
              {r.leads.length === 0 ? (
                <span className="text-[13px] text-muted">{S.noLead}</span>
              ) : (
                <Paged as="ul" resetKey={by} className="m-0 flex list-none flex-col gap-1 p-0">
                  {r.leads.map((l) => (
                    <li key={l.id} className="flex justify-between gap-3 text-[13px]">
                      <Link href={`/leads/${l.id}`} className="min-w-0 truncate text-blue underline underline-offset-4">
                        {l.name}
                      </Link>
                      <span className="font-mono">US$ {money(l.usd)}</span>
                    </li>
                  ))}
                </Paged>
              )}
            </div>
          </details>
        </li>
      ))}
    </Paged>
  );
}

/** F3d's paid sources, one line per provider and kind. */
export function SourceSpend({ rows }: { rows: SourceRow[] }) {
  return (
    <section aria-labelledby="src-title" className="flex flex-col gap-2">
      <h2 id="src-title" className="text-2xl">
        {S.sources.title}
      </h2>
      <p className="text-[13px] text-muted">{S.sources.intro}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{S.sources.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {rows.map((r) => (
            <li key={`${r.provider}:${r.kind}`} className="border-b border-line last:border-b-0">
              {r.leads.length === 0 ? (
                <div className="flex min-h-11 items-center justify-between gap-3 px-3.5 py-3">
                  <span className="text-sm font-semibold">{r.label}</span>
                  <span className="flex items-center gap-3">
                    <Badge tone="cold">{r.runs}</Badge>
                    <span className="font-mono text-sm">US$ {money(r.usd)}</span>
                  </span>
                </div>
              ) : (
                <details>
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3.5 py-3">
                    <span className="text-sm font-semibold">{r.label}</span>
                    <span className="flex items-center gap-3">
                      <Badge tone="cold">{r.runs}</Badge>
                      <span className="font-mono text-sm">US$ {money(r.usd)}</span>
                    </span>
                  </summary>
                  {(
                    <div className="flex flex-col gap-1 border-t border-line bg-ground px-3.5 py-3">
                      <span className="font-mono text-xs text-muted">{S.leadsOf}</span>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {r.leads.map((l) => (
                          <li key={l.id} className="flex justify-between gap-3 text-[13px]">
                            <Link href={`/leads/${l.id}`} className="min-w-0 truncate text-blue underline underline-offset-4">
                              {l.name}
                            </Link>
                            <span className="font-mono">US$ {money(l.usd)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
