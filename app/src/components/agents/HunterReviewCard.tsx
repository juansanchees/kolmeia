"use client";

import { useState, useTransition } from "react";
import { adjustResearch } from "@/app/(app)/agentes/actions";
import { finishHunterAction } from "@/app/(app)/agentes/agent-actions";
import { DarkChoice, GhostButton, PrimaryButton } from "@/components/research/controls";
import { usd } from "@/components/research/format";
import type { RunRow } from "@/lib/research/rows";
import { DEFAULT_CAPS, RIGORS, type Rigor } from "@/lib/research/types";
import { SCHEDULES, type Schedule } from "@/lib/agents/types";
import { t } from "@/messages/pt";

const H = t.agents.hunter;
const R = t.agents.review;
const P = t.research.plan;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 border-t border-line py-2 text-sm sm:grid-cols-[14rem_1fr]">
      <dt className="font-mono text-xs text-muted">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

/** Setup chat, last step: pick rigor and frequency, review, create PAUSED. Never approves or runs a search. */
export function HunterReviewCard({ agentId, run, defaultName }: { agentId: string; run: RunRow; defaultName: string }) {
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
      <section aria-labelledby="review-title" className="box-border flex w-full flex-col gap-3.5 self-start border border-blue bg-surface p-4 sm:max-w-[92%] sm:p-[18px]">
        <h2 id="review-title" className="text-[22px]">
          {R.title.replace("{name}", name.trim())}
        </h2>
        <dl className="m-0">
          <Row label={R.target}>{target}</Row>
          <Row label={R.region}>{run.region_text}</Row>
          <Row label={R.rigor}>{P.rigorNames[rigor]}</Row>
          <Row label={R.schedule}>{H.schedules[schedule]}</Row>
          <Row label={R.sources}>{R.sourcesValue}</Row>
          <Row label={R.maxCost}>US$ {usd(caps.maxCostUsd)}</Row>
          <Row label={R.maxTime}>{R.maxTimeValue.replace("{minutes}", String(caps.maxMinutes))}</Row>
          <Row label={R.limit}>{R.limitValue.replace("{n}", String(caps.maxCandidates))}</Row>
        </dl>
        <p className="bg-warn-soft px-3 py-2.5 text-sm text-warn">{R.paused}</p>
        <div className="flex flex-wrap items-center gap-4">
          <GhostButton disabled={pending} onClick={() => setStage("pick")}>
            {R.back}
          </GhostButton>
          <PrimaryButton type="button" disabled={pending} onClick={create}>
            {R.create}
          </PrimaryButton>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="pick-title" className="box-border flex w-full flex-col gap-3.5 self-start border border-blue bg-surface p-4 sm:max-w-[92%] sm:p-[18px]">
      <h2 id="pick-title" className="text-[22px]">
        {P.title}
      </h2>
      {plan.summary && <p className="text-[15px]">{plan.summary}</p>}
      {plan.places.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {plan.places.map((p) => (
            <li key={p} className="border border-blue bg-blue-soft px-3 py-2 text-sm font-semibold text-blue-ink">
              {p}
            </li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <div className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          <span className="font-semibold">{P.warnings}: </span>
          {plan.warnings.join(" ")}
        </div>
      )}

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={pending}>
        <legend className="mb-2 font-mono text-xs text-muted">{H.q5}</legend>
        <div role="group" aria-label={P.rigorLabel} className="flex flex-wrap gap-2">
          {RIGORS.map((r) => (
            <DarkChoice key={r} pressed={rigor === r} onClick={() => setRigor(r)}>
              {P.rigorNames[r]}
            </DarkChoice>
          ))}
        </div>
        <p className="text-[13px] text-muted">{P.rigorHelp[rigor]}</p>
      </fieldset>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={pending}>
        <legend className="mb-2 font-mono text-xs text-muted">{H.q6}</legend>
        <div className="flex flex-wrap gap-2">
          {SCHEDULES.map((s) => (
            <DarkChoice key={s} pressed={schedule === s} onClick={() => setSchedule(s)}>
              {H.schedules[s]}
            </DarkChoice>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1 font-mono text-xs text-muted">
        {H.nameLabel}
        <input
          type="text"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-11 w-full border border-edge bg-surface px-3 font-body text-[15px] text-ink"
        />
      </label>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <PrimaryButton type="button" disabled={pending || !name.trim()} onClick={() => setStage("review")}>
          {H.review}
        </PrimaryButton>
        <GhostButton onClick={() => setAdjusting((v) => !v)} aria-expanded={adjusting} aria-controls="adjust-box" disabled={pending}>
          {P.adjust}
        </GhostButton>
      </div>
      {adjusting && (
        <form id="adjust-box" onSubmit={adjust} className="flex flex-wrap items-end gap-2.5 border-t border-line pt-3.5">
          <label className="flex min-w-0 flex-[1_1_320px] flex-col gap-1 font-mono text-xs text-muted">
            {t.research.conversation.adjustLabel}
            <textarea
              rows={2}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.research.conversation.adjustPlaceholder}
              className="min-h-[46px] w-full resize-y border border-edge bg-surface p-3 font-body text-[15px] text-ink"
            />
          </label>
          <button
            type="submit"
            disabled={pending || !text.trim()}
            className="min-h-[46px] border border-ink bg-ink px-4 text-[15px] font-semibold text-white disabled:opacity-60"
          >
            {t.research.conversation.adjustSend}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
