import Link from "next/link";
import { computeCounts } from "@/lib/research/engine";
import type { CandidateRow, RunRow, SourceRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import { CHECKS_BY_RIGOR, SECOND_PASS_BY_RIGOR, STAGES, type Stage } from "@/lib/research/types";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { usd } from "./format";
import { RunControls } from "./RunControls";
import { Meter, Stat as Counter } from "./controls";
import { CountPill, HexPanel } from "@/components/ui";

/** Prototype "Buscando": counters, stages, what is being seen, sources, money, pause/continue/cancel. */
const BACK = "k-link inline-flex min-h-11 items-center self-start font-mono text-sm text-ink underline decoration-honey decoration-2 underline-offset-4";

export async function Progress({
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
  const t = await getT();
  const R = t.research.running;
  const c = computeCounts(candidates, checks, sources.length);
  const stage: Stage = run.progress.stage ?? "discover_sources";
  const kinds = CHECKS_BY_RIGOR[run.rigor];
  const stages = STAGES.filter((s) => s !== "second_pass" || SECOND_PASS_BY_RIGOR[run.rigor]);
  const nowIndex = stages.indexOf(stage);
  const seen = run.progress.seen ?? [];
  const paused = run.status === "paused";

  return (
    <div className="flex flex-col gap-5">
      <div className="k-in flex flex-col gap-1">
        <Link href={`/agentes/pesquisa/${run.id}?view=conversa`} className={BACK}>
          {R.back}
        </Link>
        <h2 className="text-3xl">{R.title}</h2>
        <p className="m-0 text-base text-[#4a5361]">
          {run.title} · {t.research.plan.rigorNames[run.rigor].toLowerCase()}
        </p>
      </div>

      <section aria-label={R.stageCounts} className="k-in grid gap-3 [animation-delay:.06s] [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
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
        <HexPanel as="section" aria-labelledby="stages-title" c={18} wrapClassName="k-in min-w-0 flex-[1_1_300px] [animation-delay:.12s]" className="flex flex-col gap-3 py-5">
          <h2 id="stages-title" className="font-body text-lg font-semibold normal-case tracking-normal">
            {R.stages}
          </h2>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {stages.map((s, i) => {
              const state = i < nowIndex ? "done" : i === nowIndex ? "now" : "pending";
              return (
                <li key={s} className={`flex items-start gap-3 rounded-[12px] px-3 py-2.5 ${state === "now" ? "bg-honey-soft shadow-[inset_4px_0_0_var(--color-honey)]" : ""}`} aria-current={state === "now" ? "step" : undefined}>
                  <span className={`h-fit min-w-20 rounded-full px-2 py-0.5 text-center text-[13px] font-medium ${state === "done" ? "bg-ok-soft text-ok" : state === "now" ? "bg-honey text-ink" : "bg-cold text-cold-ink"}`}>
                    {R.stageState[state]}
                  </span>
                  <span className="flex flex-col">
                    <span className="text-base font-semibold">{R.stageNames[s]}</span>
                    <span className="text-[15px] text-[#4a5361]">{R.stageHelp[s]}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </HexPanel>

        <HexPanel as="section" aria-labelledby="seen-title" c={18} wrapClassName="k-in min-w-0 flex-[1_1_300px] [animation-delay:.16s]" className="flex flex-col gap-3 py-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="seen-title" className="font-body text-lg font-semibold normal-case tracking-normal">
              {R.seen}
            </h2>
            <span className="font-mono text-sm text-[#4a5361]">{R.seenNote}</span>
          </div>
          {seen.length === 0 && <p className="m-0 text-base text-[#4a5361]">{R.seenEmpty}</p>}
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-live="polite">
            {seen.map((s, i) => (
              <li key={`${s.name}-${i}`} className="k-row flex gap-3 rounded-[12px] px-3 py-2.5">
                <span className={`h-fit min-w-12 rounded-full px-2 py-0.5 text-center text-[13px] font-medium ${s.verdict === "keep" ? "bg-ok-soft text-ok" : s.verdict === "drop" ? "bg-warn-soft text-warn" : "bg-cold text-cold-ink"}`}>
                  {R.verdict[s.verdict]}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-base font-semibold">{s.name}</span>
                  <span className="text-[15px]">{s.line}</span>
                  {s.source && <span className="font-mono text-[13px] text-[#4a5361]">{s.source}</span>}
                </span>
              </li>
            ))}
          </ul>
        </HexPanel>
      </div>

      <HexPanel as="section" aria-labelledby="sources-title" c={18} wrapClassName="k-in [animation-delay:.2s]" className="flex flex-col gap-3 py-5">
        <h2 id="sources-title" className="flex items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">
          {R.sources} <CountPill>{sources.length}</CountPill>
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {sources.map((s) => (
            <li key={s.id} className="k-row flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[12px] px-3 py-2.5 text-base">
              <span className={`rounded-full px-2 py-0.5 text-[13px] font-medium ${s.status === "used" ? "bg-ok-soft text-ok" : s.status === "blocked" || s.status === "error" ? "bg-warn-soft text-warn" : "bg-cold text-cold-ink"}`}>
                {R.sourceStatus[s.status]}
              </span>
              {s.url ? (
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="k-link text-ink underline decoration-honey decoration-2 underline-offset-4">
                  {s.title}
                </a>
              ) : (
                <span>{s.title}</span>
              )}
              {s.note && <span className="text-[15px] text-[#4a5361]">{s.note}</span>}
            </li>
          ))}
        </ul>
      </HexPanel>

      <HexPanel as="section" aria-label={R.money} tone="honey" c={18} wrapClassName="k-in [animation-delay:.24s]" className="flex flex-wrap items-center justify-between gap-4 py-5">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1.5">
          {!readOnly && <span className="text-base font-semibold">{R.keepOpen}</span>}
          <span className="text-base">{paused ? (run.progress.pauseReason === "daily_cap" ? R.pausedDailyCap : R.paused) : readOnly ? "" : R.keepOpenBody}</span>
          <span className="font-mono text-sm text-ink">
            {R.money}: {fill(R.moneyOf, { a: usd(run.spent_cost_usd, t.intl), b: usd(run.max_cost_usd, t.intl) })}
          </span>
          <Meter value={run.spent_cost_usd} max={run.max_cost_usd} className="max-w-md bg-surface!" />
        </div>
        {!readOnly && <RunControls runId={run.id} paused={paused} />}
      </HexPanel>
    </div>
  );
}
