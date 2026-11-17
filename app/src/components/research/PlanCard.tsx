"use client";

import { useState, useTransition } from "react";
import { adjustResearch, approveResearch } from "@/app/(app)/agentes/actions";
import type { RunRow } from "@/lib/research/rows";
import { CHECKS_BY_RIGOR, DEFAULT_CAPS, HARD_CEILING, RIGORS, SECOND_PASS_BY_RIGOR, type Rigor } from "@/lib/research/types";
import { useT } from "@/lib/i18n/client";
import { DarkChoice, GhostButton, StepSet } from "./controls";
import { Badge, buttonClass, Chevron, HexButton, Notice, TextArea, TextInput } from "@/components/ui";
import { usd } from "./format";

function Row({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return <li className={`border-t border-[#e3e6ec] py-2 first:border-t-0 ${accent ? "text-[15px] text-[#4a5361]" : "text-base"}`}>{children}</li>;
}

/** The plan to approve (rule P4): where, what is checked, rigor, caps, cost ceiling. */
export function PlanCard({ run, readOnly }: { run: RunRow; readOnly: boolean }) {
  const t = useT();
  const P = t.research.plan;
  const C = t.research.conversation;
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
      className="box-border flex w-full flex-col gap-5 self-start rounded-2xl border-2 border-honey-edge bg-surface p-4 sm:max-w-[92%] sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <h2 id="plan-title" className="text-2xl">
          {P.title}
        </h2>
        <Badge tone="honey">
          {P.approveFirst} · {t.ai.suggestion}
        </Badge>
      </div>
      {plan.summary && <p className="m-0 text-base">{plan.summary}</p>}

      {plan.places.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{readOnly ? C.understoodAsShort : C.understoodAs}</span>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {plan.places.map((p) => (
              <li key={p}>
                {readOnly ? (
                  <span className="inline-block rounded-full border-2 border-honey bg-honey-light px-4 py-1.5 text-[15px] font-semibold text-ink">{p}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => removePlace(p)}
                    disabled={pending}
                    aria-label={`${C.removeChip}: ${p}`}
                    className="k-btn inline-flex min-h-11 items-center gap-1.5 rounded-full border-2 border-honey bg-honey-light pl-4 pr-3 text-[15px] font-semibold text-ink"
                  >
                    {p} <span aria-hidden="true">×</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="m-0 text-[15px] text-[#4a5361]">{C.regionNote}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col rounded-2xl bg-ground p-4">
          <h3 className="mb-1.5 font-mono text-[13px] font-normal uppercase tracking-wide text-[#4a5361]">{P.where}</h3>
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
        <div className="flex flex-col rounded-2xl bg-ground p-4">
          <h3 className="mb-1.5 font-mono text-[13px] font-normal uppercase tracking-wide text-[#4a5361]">{P.what}</h3>
          <ol className="m-0 list-none p-0">
            {checks.map((c, i) => (
              <Row key={c}>{i < CHECKS_BY_RIGOR[rigor].length ? `${i + 1}. ${c}` : c}</Row>
            ))}
          </ol>
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <Notice tone="warn">
          <span className="font-semibold">{P.warnings}: </span>
          {plan.warnings.join(" ")}
        </Notice>
      )}

      <StepSet n={1} title={P.rigor} hint={P.rigorHelp[rigor]} disabled={readOnly}>
        <div role="group" aria-label={P.rigorLabel} className="flex flex-wrap gap-2">
          {RIGORS.map((r) => (
            <DarkChoice key={r} pressed={rigor === r} onClick={() => pickRigor(r)}>
              {P.rigorNames[r]}
            </DarkChoice>
          ))}
        </div>
        {rigor === "strict" && <Notice tone="warn">{P.strictNote}</Notice>}
      </StepSet>

      <StepSet n={2} title={P.caps} hint={P.capsHint} disabled={readOnly}>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
            {P.maxCandidates}
            <TextInput
              type="number"
              min={1}
              max={HARD_CEILING.maxCandidates}
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
              className="w-36 font-body"
            />
          </label>
          <label className="flex flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
            {P.maxCost}
            <TextInput
              type="number"
              min={0.5}
              max={HARD_CEILING.maxCostUsd}
              step={0.5}
              value={maxCost}
              onChange={(e) => setMaxCost(Number(e.target.value))}
              className="w-36 font-body"
            />
          </label>
        </div>
        <p className="m-0 self-start rounded-full bg-honey-pill px-4 py-1.5 text-base font-semibold">
          {P.costCeiling} {usd(Number.isFinite(maxCost) ? maxCost : 0, t.intl)}
        </p>
      </StepSet>

      {!readOnly && (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <HexButton type="button" onClick={approve} disabled={pending}>
              {P.approve} <Chevron className="k-arrow" />
            </HexButton>
            <GhostButton onClick={() => setAdjusting((v) => !v)} aria-expanded={adjusting} aria-controls="adjust-box" disabled={pending}>
              {P.adjust}
            </GhostButton>
            <span className="text-[15px] text-[#4a5361]">{P.takesMinutes}</span>
          </div>
          {adjusting && (
            <form id="adjust-box" onSubmit={sendAdjust} className="flex flex-wrap items-end gap-2.5 border-t border-[#e3e6ec] pt-4">
              <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
                {C.adjustLabel}
                <TextArea
                  rows={2}
                  maxLength={500}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={C.adjustPlaceholder}
                  className="resize-y font-body normal-case tracking-normal"
                />
              </label>
              <button type="submit" disabled={pending || !text.trim()} className={buttonClass("primary")}>
                {C.adjustSend}
              </button>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="m-0 text-base font-medium text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
