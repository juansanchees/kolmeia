"use client";

import { useState, useTransition } from "react";
import { adjustResearch } from "@/app/(app)/agentes/actions";
import { finishHunterAction } from "@/app/(app)/agentes/agent-actions";
import { DarkChoice, GhostButton, InfoRow as Row, StepSet } from "@/components/research/controls";
import { buttonClass, Chevron, HexButton, Notice, TextArea, TextInput } from "@/components/ui";
import { usd } from "@/components/research/format";
import type { RunRow } from "@/lib/research/rows";
import { DEFAULT_CAPS, RIGORS, type Rigor } from "@/lib/research/types";
import { SCHEDULES, type Schedule } from "@/lib/agents/types";
import { useT } from "@/lib/i18n/client";

/** Setup chat, last step: pick rigor and frequency, review, create PAUSED. Never approves or runs a search. */
export function HunterReviewCard({ agentId, run, defaultName }: { agentId: string; run: RunRow; defaultName: string }) {
  const t = useT();
  const H = t.agents.hunter;
  const R = t.agents.review;
  const P = t.research.plan;
  const plan = run.plan!;
  const [stage, setStage] = useState<"pick" | "review">("pick");
  const [rigor, setRigor] = useState<Rigor>(run.rigor);
  const [schedule, setSchedule] = useState<Schedule>("weekly");
  const [name, setName] = useState(defaultName);
  const [adjusting, setAdjusting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const caps = DEFAULT_CAPS[rigor];
  const target = run.request_text.split("\n")[0];

  const adjust = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await adjustResearch(run.id, text);
      setError(r.status === "error" ? (r.message ?? H.errors.failed) : null);
      if (r.status !== "error") {
        setText("");
        setAdjusting(false);
      }
    });
  };

  const create = () =>
    start(async () => {
      const r = await finishHunterAction(agentId, { name, rigor, schedule });
      if (r?.status === "error") setError(r.message ?? H.errors.failed);
    });

  if (stage === "review") {
    return (
      <section aria-labelledby="review-title" className="box-border flex w-full flex-col gap-5 self-start rounded-2xl border-2 border-honey-edge bg-surface p-4 sm:max-w-[92%] sm:p-6">
        <h2 id="review-title" className="text-2xl">
          {R.title.replace("{name}", name.trim())}
        </h2>
        <dl className="m-0">
          <Row label={R.target}>{target}</Row>
          <Row label={R.region}>{run.region_text}</Row>
          <Row label={R.rigor}>{P.rigorNames[rigor]}</Row>
          <Row label={R.schedule}>{H.schedules[schedule]}</Row>
          <Row label={R.sources}>{R.sourcesValue}</Row>
          <Row label={R.maxCost}>US$ {usd(caps.maxCostUsd, t.intl)}</Row>
          <Row label={R.maxTime}>{R.maxTimeValue.replace("{minutes}", String(caps.maxMinutes))}</Row>
          <Row label={R.limit}>{R.limitValue.replace("{n}", String(caps.maxCandidates))}</Row>
        </dl>
        <Notice tone="info">{R.paused}</Notice>
        <div className="flex flex-wrap items-center gap-4">
          <GhostButton disabled={pending} onClick={() => setStage("pick")}>
            {R.back}
          </GhostButton>
          <HexButton type="button" disabled={pending} onClick={create}>
            {R.create} <Chevron className="k-arrow" />
          </HexButton>
        </div>
        {error && (
          <p role="alert" className="m-0 text-base font-medium text-danger">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="pick-title" className="box-border flex w-full flex-col gap-5 self-start rounded-2xl border-2 border-honey-edge bg-surface p-4 sm:max-w-[92%] sm:p-6">
      <h2 id="pick-title" className="text-2xl">
        {P.title}
      </h2>
      {plan.summary && <p className="m-0 text-base">{plan.summary}</p>}
      {plan.places.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {plan.places.map((p) => (
            <li key={p} className="rounded-full border-2 border-honey bg-honey-light px-4 py-1.5 text-[15px] font-semibold text-ink">
              {p}
            </li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <Notice tone="warn">
          <span className="font-semibold">{P.warnings}: </span>
          {plan.warnings.join(" ")}
        </Notice>
      )}

      <StepSet n={1} title={H.q5} hint={P.rigorHelp[rigor]} disabled={pending}>
        <div role="group" aria-label={P.rigorLabel} className="flex flex-wrap gap-2">
          {RIGORS.map((r) => (
            <DarkChoice key={r} pressed={rigor === r} onClick={() => setRigor(r)}>
              {P.rigorNames[r]}
            </DarkChoice>
          ))}
        </div>
      </StepSet>

      <StepSet n={2} title={H.q6} disabled={pending}>
        <div className="flex flex-wrap gap-2">
          {SCHEDULES.map((s) => (
            <DarkChoice key={s} pressed={schedule === s} onClick={() => setSchedule(s)}>
              {H.schedules[s]}
            </DarkChoice>
          ))}
        </div>
      </StepSet>

      <StepSet n={3} title={H.nameLabel}>
        <TextInput aria-label={H.nameLabel} type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </StepSet>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <HexButton type="button" disabled={pending || !name.trim()} onClick={() => setStage("review")}>
          {H.review}
        </HexButton>
        <GhostButton onClick={() => setAdjusting((v) => !v)} aria-expanded={adjusting} aria-controls="adjust-box" disabled={pending}>
          {P.adjust}
        </GhostButton>
      </div>
      {adjusting && (
        <form id="adjust-box" onSubmit={adjust} className="flex flex-wrap items-end gap-2.5 border-t border-[#e3e6ec] pt-4">
          <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5 font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
            {t.research.conversation.adjustLabel}
            <TextArea
              rows={2}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.research.conversation.adjustPlaceholder}
              className="resize-y font-body normal-case tracking-normal"
            />
          </label>
          <button type="submit" disabled={pending || !text.trim()} className={buttonClass("primary")}>
            {t.research.conversation.adjustSend}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="m-0 text-base font-medium text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
