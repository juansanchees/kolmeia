"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setQualifierAction } from "@/app/(app)/agentes/qualifier-actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, Button } from "@/components/ui";
import { QualifierCapForm } from "@/components/qualifier/QualifierCapForm";
import { TakeOverButton } from "@/components/qualifier/TakeOverButton";
import { cardLines, type QualifierStatus } from "@/lib/qualifier/view";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** Pausar / Ligar. Same pattern as AgentPowerButton, but the Qualificador is not an agent row. */
function Power({ running }: { running: boolean }) {
  const t = useT();
  const Q = t.qualifier;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={running ? "secondary" : "primary"}
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await setQualifierAction({ status: running ? "paused" : "on" });
            if (r.status === "error") setError(r.message ?? Q.errors.failed);
          })
        }
      >
        {running ? Q.pause : Q.turnOn}
      </Button>
      {error && (
        <span role="alert" className="text-base text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/** The Qualificador on top of AGENTES. Caps can be edited here or on the Gastos screen. */
export function QualifierCard({ status, placesOn, isOwner = false }: { status: QualifierStatus; placesOn: boolean; isOwner?: boolean }) {
  const t = useT();
  const Q = t.qualifier;
  const lines = cardLines(status, placesOn, t);
  const running = status.status === "on";
  return (
    <section aria-labelledby="qualifier-title" className="flex flex-col gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] md:p-6">
      <AutoRefresh seconds={20} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="qualifier-title" className="text-[26px]">
            {Q.title}
          </h2>
          <span className="text-base text-[#4a5361]">{Q.intro}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={running ? "ok" : "neutral"} dot={running}>{running ? Q.on : Q.pausedLabel}</Badge>
          <Power running={running} />
        </div>
      </div>
      {!running && status.paused_reason && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-[14px] border-2 border-[#f0c48f] bg-warn-soft px-4 py-3 text-base text-warn">
          <p className="m-0">{Q.paused[status.paused_reason]}</p>
          {isOwner && status.paused_reason === "no_access" && <TakeOverButton />}
        </div>
      )}
      {lines.warning && (
        <p role="status" className="m-0 text-base text-warn">
          {lines.warning}
        </p>
      )}
      <p className="m-0 rounded-[14px] bg-honey-soft px-4 py-3 text-lg font-semibold">{lines.spent}</p>
      <p className="m-0 text-base">
        {lines.queued} · {lines.today}
      </p>
      <p className="m-0 text-[15px] text-[#4a5361]">{lines.steps}</p>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0 font-mono text-sm text-[#4a5361]" aria-label={Q.levelsTitle}>
        {lines.levels.map(([n, c]) => (
          <li key={n} className="rounded-full bg-cold px-3 py-1">
            {fill(Q.levelLine, { count: c, n, name: Q.levelNames[n as 0 | 1 | 2 | 3 | 4] })}
          </li>
        ))}
      </ul>
      <details className="text-base">
        <summary className="k-link min-h-11 w-fit cursor-pointer rounded-[10px] py-2.5 font-medium underline">{t.spend.changeCap}</summary>
        <QualifierCapForm status={status} />
      </details>
      <Link href="/agentes/gastos" className="k-link w-fit text-base font-medium underline">
        {Q.seeSpend}
      </Link>
    </section>
  );
}
