import { Badge, CountPill, HexPanel, Notice, StepTitle } from "@/components/ui";
import { InfoRow } from "@/components/research/controls";
import { when } from "@/components/email/format";
import { usd } from "@/components/research/format";
import type { RunRow } from "@/lib/research/rows";
import type { AgentRow } from "@/lib/agents/types";
import { agentMetrics } from "@/lib/agents/view";
import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import type { Messages } from "@/lib/i18n";
import { AgentPowerButton } from "./AgentPowerButton";
import { ArchiveButton } from "./ArchiveButton";
import { Paged } from "@/components/Pager";
import { AgentHead, DlStat } from "./AgentHead";
import { AgentLivePanel } from "./AgentLivePanel";
import type { AgentLive } from "@/lib/agents/live";

type Cfg = { audience?: string; audienceText?: string; region?: string; rigor?: keyof Messages["research"]["plan"]["rigorNames"]; caps?: { maxCandidates: number; maxCostUsd: number; maxMinutes: number } };

const CAP_REASONS = ["daily_cap", "user_cap", "global_cap"];

export async function AgentDetail({ agent, setupRun, runs, now, live }: { agent: AgentRow; setupRun: RunRow | null; runs: RunRow[]; now: Date; live: AgentLive | null }) {
  const t = await getT();
  const A = t.agents;
  const R = A.review;
  const m = agentMetrics(runs, setupRun?.spent_cost_usd ?? 0);
  const running = agent.status === "running";
  const upcoming = running && agent.next_run_at && new Date(agent.next_run_at).getTime() > now.getTime();
  const c = agent.config as Cfg;
  const aud = c.audience === "other" ? c.audienceText : c.audience ? (A.hunter.audiences as Record<string, string>)[c.audience] : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {live && agent.status !== "draft" && <AgentLivePanel agentId={agent.id} initial={live} canRun />}
      <HexPanel as="section" aria-labelledby="agent-title" raised wrapClassName="k-in" className="flex flex-col gap-7 py-7">
        <AgentHead id="agent-title" name={agent.name} type={agent.type} typeLabel={A.types[agent.type]} status={agent.status} statusLabel={A.statuses[agent.status]} />

        <div className="flex flex-col gap-3">
          <StepTitle n={1} as="h3">{A.detail.steps.setup}</StepTitle>
          <dl className="m-0 md:pl-[42px]">
            {aud && <InfoRow label={R.target}>{aud}</InfoRow>}
            {c.region && <InfoRow label={R.region}>{c.region}</InfoRow>}
            {c.rigor && <InfoRow label={R.rigor}>{t.research.plan.rigorNames[c.rigor]}</InfoRow>}
            <InfoRow label={R.schedule}>{A.hunter.schedules[agent.schedule]}</InfoRow>
            <InfoRow label={R.sources}>{R.sourcesValue}</InfoRow>
            {c.caps && (
              <>
                <InfoRow label={R.maxCost}>US$ {usd(c.caps.maxCostUsd, t.intl)}</InfoRow>
                <InfoRow label={R.maxTime}>{R.maxTimeValue.replace("{minutes}", String(c.caps.maxMinutes))}</InfoRow>
                <InfoRow label={R.limit}>{R.limitValue.replace("{n}", String(c.caps.maxCandidates))}</InfoRow>
              </>
            )}
            {setupRun && <InfoRow label={A.detail.creationCost}>US$ {usd(setupRun.spent_cost_usd, t.intl)}</InfoRow>}
          </dl>
        </div>

        <div className="flex flex-col gap-3">
          <StepTitle n={2} as="h3" hint={A.detail.turnOnHelp}>{A.detail.steps.power}</StepTitle>
          <div className="flex flex-col gap-3 md:pl-[42px]">
            {agent.status === "paused" && agent.paused_reason && (
              <Notice tone="warn">{CAP_REASONS.includes(agent.paused_reason) ? A.capWarning : A.paused[agent.paused_reason]}</Notice>
            )}
            {agent.status === "paused" && agent.paused_reason && CAP_REASONS.includes(agent.paused_reason) && (
              <p className="m-0 text-base">{A.paused[agent.paused_reason]}</p>
            )}
            {upcoming && <p className="m-0 text-base">{A.detail.nextRun.replace("{when}", when(agent.next_run_at, t.intl))}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <AgentPowerButton agentId={agent.id} status={agent.status} />
              {!running && <ArchiveButton agentId={agent.id} />}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <StepTitle n={3} as="h3">{A.detail.steps.numbers}</StepTitle>
          <dl className="m-0 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] md:pl-[42px]">
            {(
              [
                [A.metrics.runs, m.runs],
                [A.metrics.found, m.found],
                [A.metrics.verified, m.verified],
                [A.metrics.refuted, m.refuted],
                [A.metrics.cost, `US$ ${usd(m.costUsd, t.intl)}`],
              ] as const
            ).map(([label, value]) => (
              <DlStat key={label} label={label} value={value} />
            ))}
          </dl>
        </div>
      </HexPanel>

      {runs.length > 0 && (
        <HexPanel as="section" aria-labelledby="agent-history" wrapClassName="k-in [animation-delay:.08s]" className="flex flex-col gap-3 py-6">
          <h3 id="agent-history" className="flex items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">
            {A.detail.history} <CountPill>{runs.length}</CountPill>
          </h3>
          <Paged as="ul" className="m-0 flex list-none flex-col gap-1 p-0">
            {runs.map((r) => (
              <li key={r.id}>
                <Link href={`/agentes/pesquisa/${r.id}`} className="k-row flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[12px] px-3.5 py-2.5 text-ink no-underline">
                  <span className="min-w-0 font-semibold">{r.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[15px] text-[#4a5361]">
                    <Badge tone="neutral" className="py-0.5">{t.research.status[r.status]}</Badge>
                    <span className="font-mono text-sm">{when(r.created_at, t.intl)}</span>
                    <CountPill>{r.progress?.counts?.verified ?? 0}</CountPill>
                    <span>{A.metrics.verified.toLowerCase()}</span>
                  </span>
                </Link>
              </li>
            ))}
          </Paged>
        </HexPanel>
      )}
    </div>
  );
}
