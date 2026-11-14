"use client";

import { useState, useTransition } from "react";
import { adjustResearch, approveResearch } from "@/app/(app)/agentes/actions";
import type { RunRow } from "@/lib/research/rows";
import { CHECKS_BY_RIGOR, DEFAULT_CAPS, HARD_CEILING, RIGORS, SECOND_PASS_BY_RIGOR, type Rigor } from "@/lib/research/types";
import { t } from "@/messages/pt";
import { DarkChoice, GhostButton, PrimaryButton } from "./controls";
import { usd } from "./format";

const P = t.research.plan;
const C = t.research.conversation;

function Row({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return <li className={`border-t border-line py-2 text-sm ${accent ? "text-[13px] text-blue-ink" : ""}`}>{children}</li>;
}

/** The plan to approve (rule P4): where, what is checked, rigor, caps, cost ceiling. */
export function PlanCard({ run, readOnly }: { run: RunRow; readOnly: boolean }) {
  const plan = run.plan!;
  const [rigor, setRigor] = useState<Rigor>(run.rigor);
  const [maxCandidates, setMaxCandidates] = useState(run.max_candidates);
  const [maxCost, setMaxCost] = useState(run.max_cost_usd);
  const [adjusting, setAdjusting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pickRigor = (r: Rigor) => {
    setRigor(r);
    setMaxCandidates(DEFAULT_CAPS[r].maxCandidates);
    setMaxCost(DEFAULT_CAPS[r].maxCostUsd);
  };

  const act = (fn: () => Promise<{ status: string; message?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setError(r.status === "error" ? (r.message ?? P.errors.generic) : null);
      if (r.status !== "error") after?.();
    });

  const approve = () => act(() => approveResearch(run.id, { rigor, maxCandidates, maxCostUsd: maxCost }));
  const sendAdjust = (e: React.FormEvent) => {
    e.preventDefault();
    act(() => adjustResearch(run.id, text), () => {
      setText("");
      setAdjusting(false);
    });
  };
  const removePlace = (p: string) => act(() => adjustResearch(run.id, `${C.removeRegion} ${p}`));

  const checks = [...CHECKS_BY_RIGOR[rigor].map((k) => P.checks[k]), ...(SECOND_PASS_BY_RIGOR[rigor] ? [P.checks.second_pass] : [])];

  return (
    <section
      aria-labelledby="plan-title"
      className="box-border flex w-full flex-col gap-3.5 self-start border border-blue bg-surface p-4 sm:max-w-[92%] sm:p-[18px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <h2 id="plan-title" className="text-[22px]">
          {P.title}
        </h2>
        <span className="font-mono text-xs text-blue-ink">
          {P.approveFirst} · {t.ai.suggestion}
        </span>
      </div>
      {plan.summary && <p className="text-[15px]">{plan.summary}</p>}

      {plan.places.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-xs text-muted">{readOnly ? C.understoodAsShort : C.understoodAs}</span>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {plan.places.map((p) => (
              <li key={p}>
                {readOnly ? (
                  <span className="inline-block border border-blue bg-blue-soft px-3 py-2 text-sm font-semibold text-blue-ink">{p}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => removePlace(p)}
                    disabled={pending}
                    aria-label={`${C.removeChip}: ${p}`}
                    className="min-h-11 border border-blue bg-blue-soft px-3 text-sm font-semibold text-blue-ink hover:bg-blue-wash"
                  >
                    {p} <span aria-hidden="true">×</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted">{C.regionNote}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <div className="flex flex-col">
          <h3 className="mb-1.5 font-mono text-xs font-normal text-muted">{P.where}</h3>
          <ul className="m-0 list-none p-0">
            <Row>
              <span className="font-semibold">{P.whereAll}</span>
            </Row>
            {plan.sourceTypes.map((s) => (
              <Row key={s}>{s}</Row>
            ))}
            <Row accent>{P.whereExtra}</Row>
          </ul>
        </div>
        <div className="flex flex-col">
          <h3 className="mb-1.5 font-mono text-xs font-normal text-muted">{P.what}</h3>
          <ol className="m-0 list-none p-0">
            {checks.map((c, i) => (
              <Row key={c}>{i < CHECKS_BY_RIGOR[rigor].length ? `${i + 1}. ${c}` : c}</Row>
            ))}
          </ol>
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <div className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          <span className="font-semibold">{P.warnings}: </span>
          {plan.warnings.join(" ")}
        </div>
      )}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={readOnly}>
        <legend className="mb-2 font-mono text-xs text-muted">{P.rigor}</legend>
        <div role="group" aria-label={P.rigorLabel} className="flex flex-wrap gap-2">
          {RIGORS.map((r) => (
            <DarkChoice key={r} pressed={rigor === r} onClick={() => pickRigor(r)}>
              {P.rigorNames[r]}
            </DarkChoice>
          ))}
        </div>
        <p className="text-[13px] text-muted">{P.rigorHelp[rigor]}</p>
      </fieldset>

      {rigor === "strict" && <p className="bg-warn-soft px-3 py-2.5 text-sm leading-normal text-warn">{P.strictNote}</p>}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={readOnly}>
        <legend className="mb-2 font-mono text-xs text-muted">{P.caps}</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 font-mono text-xs text-muted">
            {P.maxCandidates}
            <input
              type="number"
              min={1}
              max={HARD_CEILING.maxCandidates}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
              className="h-11 w-32 border border-edge bg-surface px-3 font-body text-[15px] text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 font-mono text-xs text-muted">
            {P.maxCost}
            <input
              type="number"
              min={0.5}
              max={HARD_CEILING.maxCostUsd}
              step={0.5}
              value={maxCost}
              onChange={(e) => setMaxCost(Number(e.target.value))}
              className="h-11 w-32 border border-edge bg-surface px-3 font-body text-[15px] text-ink"
            />
          </label>
        </div>
        <p className="text-[13px] text-muted">{P.capsHint}</p>
        <p className="text-sm font-semibold">
          {P.costCeiling} {usd(Number.isFinite(maxCost) ? maxCost : 0)}
        </p>
      </fieldset>

      {!readOnly && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <PrimaryButton type="button" onClick={approve} disabled={pending}>
              {P.approve}
            </PrimaryButton>
            <GhostButton onClick={() => setAdjusting((v) => !v)} aria-expanded={adjusting} aria-controls="adjust-box" disabled={pending}>
              {P.adjust}
            </GhostButton>
            <span className="text-[13px] text-muted">{P.takesMinutes}</span>
          </div>
          {adjusting && (
            <form id="adjust-box" onSubmit={sendAdjust} className="flex flex-wrap items-end gap-2.5 border-t border-line pt-3.5">
              <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-1 font-mono text-xs text-muted">
                {C.adjustLabel}
                <textarea
                  rows={2}
                  maxLength={500}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={C.adjustPlaceholder}
                  className="min-h-[46px] w-full resize-y border border-edge bg-surface p-3 font-body text-[15px] text-ink"
                />
              </label>
              <button
                type="submit"
                disabled={pending || !text.trim()}
                className="min-h-[46px] border border-ink bg-ink px-4 text-[15px] font-semibold text-white disabled:opacity-60"
              >
                {C.adjustSend}
              </button>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
