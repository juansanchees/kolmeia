"use client";

import Link from "next/link";
import { useState } from "react";
import { Pager, usePaged } from "@/components/Pager";
import { MA_COUNTIES } from "@/lib/coverage/ma-towns";
import { huntHref, type TownRow } from "@/lib/coverage/view";
import { Badge, Select } from "@/components/ui";
import { date } from "@/components/research/format";
import { useT } from "@/lib/i18n/client";

export function CoverageTable({ towns }: { towns: TownRow[] }) {
  const t = useT();
  const C = t.coverage;
  const [county, setCounty] = useState("");
  const [onlyUncovered, setOnlyUncovered] = useState(false);
  const shown = towns.filter((x) => (!county || x.county === county) && (!onlyUncovered || !x.covered));
  const { pageItems, pager } = usePaged(shown, `${county}|${onlyUncovered}`);
  const max = Math.max(1, ...towns.map((x) => x.leads));
  const th = "py-3 pr-3 text-[15px] font-semibold text-[#4a5361]";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{C.county}</span>
          <Select value={county} onChange={(e) => setCounty(e.target.value)} className="w-auto! min-w-48">
            <option value="">{C.allCounties}</option>
            {MA_COUNTIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          aria-pressed={onlyUncovered}
          onClick={() => setOnlyUncovered((v) => !v)}
          className={`k-btn inline-flex min-h-12 items-center gap-2 rounded-full border-2 pr-[18px] text-base text-ink ${onlyUncovered ? "border-honey bg-honey-light pl-2.5 font-semibold" : "border-line bg-surface pl-[18px]"}`}
        >
          {onlyUncovered && (
            <span aria-hidden className="k-pop inline-flex size-6 items-center justify-center rounded-full bg-ink text-white">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5L20 7" />
              </svg>
            </span>
          )}
          {C.onlyUncovered}
        </button>
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[15px] text-[#4a5361]">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block h-3 w-8 rounded-full bg-honey" />
          {C.legend}
        </span>
        <Badge tone="ok">{C.covered}</Badge>
        <Badge tone="warn">{C.uncovered}</Badge>
      </p>
      {shown.length === 0 ? (
        <p className="m-0 text-base text-[#4a5361]">{C.townsEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-base">
            <thead>
              <tr className="border-b-2 border-[#e3e6ec]">
                <th className={th}>{C.columns.town}</th>
                <th className={th}>{C.county}</th>
                <th className={th}>{C.columns.leads}</th>
                <th className={th}>{C.columns.searches}</th>
                <th className={th}>{C.columns.last}</th>
                <th className={`${th} pr-0`}>{C.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((x) => (
                <tr key={x.name} className="k-row border-b border-[#eef0f3] align-middle">
                  <td className="py-3 pr-3 font-semibold">{x.name}</td>
                  <td className="py-3 pr-3 text-[#4a5361]">{x.county}</td>
                  <td className="py-3 pr-3">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-2.5 w-20 shrink-0 overflow-hidden rounded-full bg-cold">
                        <span className="block h-full rounded-full bg-honey" style={{ width: `${x.leads === 0 ? 0 : Math.max(8, (100 * x.leads) / max)}%` }} />
                      </span>
                      <span className="font-mono">{x.leads}</span>
                    </span>
                  </td>
                  <td className="py-3 pr-3 font-mono">{x.searches}</td>
                  <td className="py-3 pr-3 font-mono text-[15px]">{date(x.last, t.intl)}</td>
                  <td className="py-3">
                    {x.covered ? (
                      <Badge tone="ok">{C.covered}</Badge>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <Badge tone="warn">{C.uncovered}</Badge>
                        <Link href={huntHref(x.name)} className="k-link inline-flex min-h-11 items-center rounded-[10px] px-1 font-semibold underline">
                          {C.hunt}
                        </Link>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager pager={pager} />
    </div>
  );
}
