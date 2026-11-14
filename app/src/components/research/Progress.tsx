import Link from "next/link";
import { computeCounts } from "@/lib/research/engine";
import type { CandidateRow, RunRow, SourceRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import { CHECKS_BY_RIGOR, SECOND_PASS_BY_RIGOR, STAGES, type Stage } from "@/lib/research/types";
import { fill, t } from "@/messages/pt";
import { usd } from "./format";
import { RunControls } from "./RunControls";

const R = t.research.running;

function Counter({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-[1_1_160px] flex-col gap-1 border border-line bg-surface p-3.5">
      <span className="font-mono text-xs text-muted">{label}</span>
      <span className="font-display text-4xl font-bold leading-none">{value}</span>
      <span className="text-[13px] text-muted">{note}</span>
    </div>
  );
}

/** Prototype "Buscando": counters, stages, what is being seen, sources, money, pause/continue/cancel. */
export function Progress({
  run,
  sources,
  candidates,
  checks,
  readOnly = false,
}: {
  readOnly?: boolean;
  run: RunRow;
  sources: SourceRow[];
  candidates: CandidateRow[];
  checks: CheckWithEvidence[];
}) {
  const c = computeCounts(candidates, checks, sources.length);
  const stage: Stage = run.progress.stage ?? "discover_sources";
  const kinds = CHECKS_BY_RIGOR[run.rigor];
  const stages = STAGES.filter((s) => s !== "second_pass" || SECOND_PASS_BY_RIGOR[run.rigor]);
  const nowIndex = stages.indexOf(stage);
  const seen = run.progress.seen ?? [];
  const paused = run.status === "paused";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={`/agentes/pesquisa/${run.id}?view=conversa`} className="font-mono text-xs text-blue underline underline-offset-4">
            {R.back}
          </Link>
          <h2 className="mt-1 text-3xl">{R.title}</h2>
          <p className="text-[15px] text-muted">
            {run.title} · {t.research.plan.rigorNames[run.rigor].toLowerCase()}
          </p>
        </div>
      </div>

      <section aria-label={R.stageCounts} className="flex flex-wrap gap-3">
        <Counter label={R.candidates} value={String(c.candidates)} note={fill(R.candidatesNote, { n: c.sources })} />
        <Counter label={R.existsOk} value={c.verified ? String(c.existsOk) : "–"} note={c.verified ? fill(R.checkedOf, { a: c.verified, b: c.candidates }) : R.notStarted} />
        {kinds.includes("has_work") && (
          <Counter label={R.hasWorkOk} value={c.verified ? String(c.hasWorkOk) : "–"} note={c.verified ? fill(R.checkedOf, { a: c.verified, b: c.candidates }) : R.notStarted} />
        )}
        {kinds.includes("fits_profile") && (
          <Counter label={R.fitsOk} value={c.verified ? String(c.fitsOk) : "–"} note={c.verified ? fill(R.checkedOf, { a: c.verified, b: c.candidates }) : R.notStarted} />
        )}
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <section aria-labelledby="stages-title" className="flex min-w-0 flex-[1_1_300px] flex-col border border-line bg-surface">
          <h2 id="stages-title" className="border-b border-ink px-4 py-3 text-xl">
            {R.stages}
          </h2>
          <ol className="m-0 list-none p-0">
            {stages.map((s, i) => {
              const state = i < nowIndex ? "done" : i === nowIndex ? "now" : "pending";
              return (
                <li key={s} className={`flex gap-3 border-b border-line px-4 py-3 last:border-b-0 ${state === "now" ? "bg-blue-wash" : ""}`} aria-current={state === "now" ? "step" : undefined}>
                  <span className={`h-fit min-w-16 px-1.5 py-0.5 text-center font-mono text-[11px] ${state === "done" ? "bg-ok-soft text-ok" : state === "now" ? "bg-blue text-white" : "bg-cold text-cold-ink"}`}>
                    {R.stageState[state]}
                  </span>
                  <span className="flex flex-col">
                    <span className="text-sm font-semibold">{R.stageNames[s]}</span>
                    <span className="text-[13px] text-muted">{R.stageHelp[s]}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-labelledby="seen-title" className="flex min-w-0 flex-[1_1_300px] flex-col border border-line bg-surface">
          <div className="flex items-baseline justify-between gap-2 border-b border-ink px-4 py-3">
            <h2 id="seen-title" className="text-xl">
              {R.seen}
            </h2>
            <span className="font-mono text-xs text-muted">{R.seenNote}</span>
          </div>
          {seen.length === 0 && <p className="px-4 py-3 text-sm text-muted">{R.seenEmpty}</p>}
          <ul className="m-0 list-none p-0" aria-live="polite">
            {seen.map((s, i) => (
              <li key={`${s.name}-${i}`} className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <span className={`h-fit min-w-10 px-1.5 py-0.5 text-center font-mono text-[11px] ${s.verdict === "keep" ? "bg-ok-soft text-ok" : s.verdict === "drop" ? "bg-warn-soft text-warn" : "bg-cold text-cold-ink"}`}>
                  {R.verdict[s.verdict]}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-semibold">{s.name}</span>
                  <span className="text-[13px]">{s.line}</span>
                  {s.source && <span className="font-mono text-[11px] text-muted">{s.source}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="sources-title" className="border border-line bg-surface">
        <h2 id="sources-title" className="border-b border-ink px-4 py-3 text-xl">
          {R.sources} · {sources.length}
        </h2>
        <ul className="m-0 list-none p-0">
          {sources.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
              <span className={`font-mono text-[11px] ${s.status === "used" ? "text-ok" : s.status === "blocked" || s.status === "error" ? "text-warn" : "text-muted"}`}>
                {R.sourceStatus[s.status]}
              </span>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                  {s.title}
                </a>
              ) : (
                <span>{s.title}</span>
              )}
              {s.note && <span className="text-[13px] text-muted">{s.note}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={R.money} className="flex flex-wrap items-center justify-between gap-4 border border-blue bg-blue-wash p-4">
        <div className="flex flex-col gap-1">
          {!readOnly && <span className="text-[15px] font-semibold">{R.keepOpen}</span>}
          <span className="text-sm">{paused ? (run.progress.pauseReason === "daily_cap" ? R.pausedDailyCap : R.paused) : readOnly ? "" : R.keepOpenBody}</span>
          <span className="font-mono text-xs text-blue-ink">
            {R.money}: {fill(R.moneyOf, { a: usd(run.spent_cost_usd), b: usd(run.max_cost_usd) })}
          </span>
        </div>
        {!readOnly && <RunControls runId={run.id} paused={paused} />}
      </section>
    </div>
  );
}
