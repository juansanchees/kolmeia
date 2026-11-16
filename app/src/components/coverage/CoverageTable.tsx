"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager, usePaged } from "@/components/Pager";
import { MA_COUNTIES } from "@/lib/coverage/ma-towns";
import { huntHref, type TownRow } from "@/lib/coverage/view";
import { Badge } from "@/components/email/bits";
import { Choice } from "@/components/research/controls";
import { date } from "@/components/research/format";
import { t } from "@/messages/pt";

const C = t.coverage;
const BAR = 12;

export function CoverageTable({ towns }: { towns: TownRow[] }) {
  const [county, setCounty] = useState("");
  const [onlyUncovered, setOnlyUncovered] = useState(false);
  const shown = towns.filter((x) => (!county || x.county === county) && (!onlyUncovered || !x.covered));
  const { pageItems, pager } = usePaged(shown, `${county}|${onlyUncovered}`);
  const max = Math.max(1, ...towns.map((x) => x.leads));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          {C.county}
          <select value={county} onChange={(e) => setCounty(e.target.value)} className="border border-line bg-surface px-3 py-2 text-base text-ink">
            <option value="">{C.allCounties}</option>
            {MA_COUNTIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <Choice pressed={onlyUncovered} onClick={() => setOnlyUncovered((v) => !v)}>{C.onlyUncovered}</Choice>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{C.townsEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-line font-mono text-xs text-muted">
                <th className="py-2 pr-3 font-normal">{C.columns.town}</th>
                <th className="py-2 pr-3 font-normal">{C.county}</th>
                <th className="py-2 pr-3 font-normal">{C.columns.leads}</th>
                <th className="py-2 pr-3 font-normal">{C.columns.searches}</th>
                <th className="py-2 pr-3 font-normal">{C.columns.last}</th>
                <th className="py-2 font-normal">{C.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((x) => {
                const filled = x.leads === 0 ? 0 : Math.max(1, Math.round((x.leads / max) * BAR));
                return (
                  <tr key={x.name} className="border-b border-line align-middle">
                    <td className="py-2 pr-3">{x.name}</td>
                    <td className="py-2 pr-3 text-muted">{x.county}</td>
                    <td className="py-2 pr-3 font-mono">
                      <span aria-hidden="true" className="text-blue">{"█".repeat(filled)}</span> {x.leads}
                    </td>
                    <td className="py-2 pr-3 font-mono">{x.searches}</td>
                    <td className="py-2 pr-3 font-mono">{date(x.last)}</td>
                    <td className="py-2">
                      {x.covered ? (
                        <Badge tone="ok">{C.covered}</Badge>
                      ) : (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <Badge tone="warn">{C.uncovered}</Badge>
                          <Link href={huntHref(x.name)} className="text-sm text-blue underline underline-offset-4">{C.hunt}</Link>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager pager={pager} />
    </div>
  );
}
