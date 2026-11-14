"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { setQualifierAction } from "@/app/(app)/agentes/qualifier-actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { btn } from "@/components/email/bits";
import { cardLines, type QualifierStatus } from "@/lib/qualifier/view";
import { fill, t } from "@/messages/pt";

const Q = t.qualifier;

/** Pausar / Ligar. Same pattern as AgentPowerButton, but the Qualificador is not an agent row. */
function Power({ running }: { running: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={running ? btn.ghost : btn.primary}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await setQualifierAction({ status: running ? "paused" : "on" });
            if (r.status === "error") setError(r.message ?? Q.errors.failed);
          })
        }
      >
        {running ? Q.pause : Q.turnOn}
      </button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/** The Qualificador on top of AGENTES. Caps are read-only here (edited on the Gastos screen). */
export function QualifierCard({ status, placesOn }: { status: QualifierStatus; placesOn: boolean }) {
  const lines = cardLines(status, placesOn);
  const running = status.status === "on";
  return (
    <section aria-labelledby="qualifier-title" className="flex flex-col gap-3 border border-line bg-surface p-4">
      <AutoRefresh seconds={20} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="qualifier-title" className="text-2xl">
            {Q.title}
          </h2>
          <span className="text-[13px] text-muted">{Q.intro}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-block whitespace-nowrap bg-cold px-2 py-0.5 font-mono text-xs text-cold-ink">{running ? Q.on : Q.pausedLabel}</span>
          <Power running={running} />
        </div>
      </div>
      {!running && status.paused_reason && (
        <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {Q.paused[status.paused_reason]}
        </p>
      )}
      {lines.warning && (
        <p role="status" className="text-sm text-warn">
          {lines.warning}
        </p>
      )}
      <p className="text-sm font-semibold">{lines.spent}</p>
      <p className="text-sm">
        {lines.queued} · {lines.today}
      </p>
      <p className="text-[13px] text-muted">{lines.steps}</p>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 font-mono text-xs text-muted" aria-label={Q.levelsTitle}>
        {lines.levels.map(([n, c]) => (
          <li key={n}>
            {fill(Q.levelLine, { count: c, n, name: Q.levelNames[n as 0 | 1 | 2 | 3 | 4] })}
          </li>
        ))}
      </ul>
      <Link href="/agentes/gastos" className="text-sm text-blue underline underline-offset-4">
        {Q.seeSpend}
      </Link>
    </section>
  );
}
