import Link from "next/link";
import { CountPill, EmptyState } from "@/components/ui";
import { usd } from "@/components/research/format";
import type { SourceRow, SpendBy, SpendRow } from "@/lib/spend/view";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";

const ROW = "rounded-[12px] border border-[#eef0f3] open:border-honey-edge open:bg-honey-hover";
const SUMMARY = "k-row min-h-12 cursor-pointer items-center rounded-[12px] px-3.5 py-3";
const LEADS = "m-2 mt-0 flex flex-col gap-1 rounded-[10px] bg-surface px-3.5 py-3";
const COINS = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2";

/** Small costs keep their fractions of a cent: nothing rounds down to "0,00". */
export function money(v: number, intl: string): string {
  return v > 0 && v < 0.01 ? new Intl.NumberFormat(intl, { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(v) : usd(v, intl);
}

/** One row per group; open a row to see the leads behind it with their cost. */
export async function SpendTable({ rows, by }: { rows: SpendRow[]; by: SpendBy }) {
  const t = await getT();
  const S = t.spend;
  if (rows.length === 0) return <EmptyState icon={COINS} title={S.empty}>{S.emptyHint}</EmptyState>;
  return (
    <Paged as="ul" resetKey={by} className="m-0 flex list-none flex-col gap-1 p-0">
      {rows.map((r) => (
        <li key={r.key}>
          <details className={ROW}>
            <summary className={`${SUMMARY} grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto]`}>
              <span className="min-w-0 truncate text-base font-semibold">{r.label}</span>
              <span className="text-right md:order-last"><CountPill>US$ {money(r.usd, t.intl)}</CountPill></span>
              <span className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[15px] text-[#4a5361] md:contents">
                <span className="truncate">{by !== "agent" && r.agent}</span>
                <span className="truncate">{by !== "step" && r.step}</span>
                <span className="truncate">{by !== "model" && r.model}</span>
                <span className="font-mono text-sm">
                  {r.inputTokens}/{r.outputTokens}
                  {r.searches + r.fetches > 0 ? ` · ${r.searches}/${r.fetches}` : ""}
                </span>
              </span>
            </summary>
            <div className={LEADS}>
              <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{S.leadsOf}</span>
              {r.leads.length === 0 ? (
                <span className="text-[15px] text-[#4a5361]">{S.noLead}</span>
              ) : (
                <Paged as="ul" resetKey={by} className="m-0 flex list-none flex-col gap-1 p-0">
                  {r.leads.map((l) => (
                    <li key={l.id} className="flex justify-between gap-3 text-[15px]">
                      <Link href={`/leads/${l.id}`} className="k-link min-w-0 truncate text-ink underline decoration-honey decoration-2 underline-offset-4">
                        {l.name}
                      </Link>
                      <span className="font-mono text-sm">US$ {money(l.usd, t.intl)}</span>
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
export async function SourceSpend({ rows }: { rows: SourceRow[] }) {
  const t = await getT();
  const S = t.spend;
  return (
    <section aria-labelledby="src-title" className="flex flex-col gap-2">
      <h2 id="src-title" className="font-body text-lg font-semibold normal-case tracking-normal">
        {S.sources.title}
      </h2>
      <p className="m-0 text-[15px] text-[#4a5361]">{S.sources.intro}</p>
      {rows.length === 0 ? (
        <EmptyState icon={COINS} title={S.sources.empty}>{S.emptyHint}</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((r) => (
            <li key={`${r.provider}:${r.kind}`}>
              {r.leads.length === 0 ? (
                <div className={`${ROW} ${SUMMARY} flex justify-between gap-3`}>
                  <span className="text-base font-semibold">{r.label}</span>
                  <span className="flex items-center gap-3">
                    <CountPill tone="cold" title={S.sources.columns.runs}>{r.runs}</CountPill>
                    <CountPill>US$ {money(r.usd, t.intl)}</CountPill>
                  </span>
                </div>
              ) : (
                <details className={ROW}>
                  <summary className={`${SUMMARY} flex justify-between gap-3`}>
                    <span className="text-base font-semibold">{r.label}</span>
                    <span className="flex items-center gap-3">
                      <CountPill tone="cold" title={S.sources.columns.runs}>{r.runs}</CountPill>
                      <CountPill>US$ {money(r.usd, t.intl)}</CountPill>
                    </span>
                  </summary>
                  {(
                    <div className={LEADS}>
                      <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{S.leadsOf}</span>
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
                        {r.leads.map((l) => (
                          <li key={l.id} className="flex justify-between gap-3 text-[15px]">
                            <Link href={`/leads/${l.id}`} className="k-link min-w-0 truncate text-ink underline decoration-honey decoration-2 underline-offset-4">
                              {l.name}
                            </Link>
                            <span className="font-mono text-sm">US$ {money(l.usd, t.intl)}</span>
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
