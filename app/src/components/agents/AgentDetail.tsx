import { Notice } from "@/components/email/bits";
import { when } from "@/components/email/format";
import { usd } from "@/components/research/format";
import type { RunRow } from "@/lib/research/rows";
import type { AgentRow } from "@/lib/agents/types";
import { agentMetrics } from "@/lib/agents/view";
import Link from "next/link";
import { t } from "@/messages/pt";
import { AgentPowerButton } from "./AgentPowerButton";
import { ArchiveButton } from "./ArchiveButton";
import { Paged } from "@/components/Pager";

const A = t.agents;
const R = A.review;

type Cfg = { audience?: string; audienceText?: string; region?: string; rigor?: keyof typeof t.research.plan.rigorNames; caps?: { maxCandidates: number; maxCostUsd: number; maxMinutes: number } };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 border-t border-line py-2 text-sm sm:grid-cols-[14rem_1fr]">
      <dt className="font-mono text-xs text-muted">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

const CAP_REASONS = ["daily_cap", "user_cap", "global_cap"];

export function AgentDetail({ agent, setupRun, runs, now }: { agent: AgentRow; setupRun: RunRow | null; runs: RunRow[]; now: Date }) {
  const m = agentMetrics(runs, setupRun?.spent_cost_usd ?? 0);
  const running = agent.status === "running";
  const upcoming = running && agent.next_run_at && new Date(agent.next_run_at).getTime() > now.getTime();
  const c = agent.config as Cfg;
  const aud = c.audience === "other" ? c.audienceText : c.audience ? (A.hunter.audiences as Record<string, string>)[c.audience] : undefined;
  return (
    <section aria-labelledby="agent-title" className="flex flex-col gap-4 border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <h2 id="agent-title" className="text-2xl">
          {agent.name}
        </h2>
        <span className="font-mono text-xs text-muted">
          {A.types[agent.type]} · <span className="border border-line px-2 py-0.5">{A.statuses[agent.status]}</span>
        </span>
      </div>
      <dl className="m-0">
        {aud && <Row label={R.target}>{aud}</Row>}
        {c.region && <Row label={R.region}>{c.region}</Row>}
        {c.rigor && <Row label={R.rigor}>{t.research.plan.rigorNames[c.rigor]}</Row>}
        <Row label={R.schedule}>{A.hunter.schedules[agent.schedule]}</Row>
        <Row label={R.sources}>{R.sourcesValue}</Row>
        {c.caps && (
          <>
            <Row label={R.maxCost}>US$ {usd(c.caps.maxCostUsd)}</Row>
            <Row label={R.maxTime}>{R.maxTimeValue.replace("{minutes}", String(c.caps.maxMinutes))}</Row>
            <Row label={R.limit}>{R.limitValue.replace("{n}", String(c.caps.maxCandidates))}</Row>
          </>
        )}
        {setupRun && <Row label={A.detail.creationCost}>US$ {usd(setupRun.spent_cost_usd)}</Row>}
      </dl>
      {agent.status === "paused" && agent.paused_reason && (
        <Notice tone="warn">{CAP_REASONS.includes(agent.paused_reason) ? A.capWarning : A.paused[agent.paused_reason]}</Notice>
      )}
      {agent.status === "paused" && agent.paused_reason && CAP_REASONS.includes(agent.paused_reason) && (
        <p className="text-sm">{A.paused[agent.paused_reason]}</p>
      )}
      {upcoming && <p className="text-sm">{A.detail.nextRun.replace("{when}", when(agent.next_run_at))}</p>}
      <dl className="m-0">
        <Row label={A.metrics.runs}>{m.runs}</Row>
        <Row label={A.metrics.found}>{m.found}</Row>
        <Row label={A.metrics.verified}>{m.verified}</Row>
        <Row label={A.metrics.refuted}>{m.refuted}</Row>
        <Row label={A.metrics.cost}>US$ {usd(m.costUsd)}</Row>
      </dl>
      {runs.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold">{A.detail.history}</h3>
          <Paged as="ul" className="m-0 flex list-none flex-col p-0">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 border-t border-line py-2 text-sm">
                <Link href={`/agentes/pesquisa/${r.id}`} className="text-blue underline underline-offset-4">
                  {r.title}
                </Link>
                <span className="font-mono text-xs text-muted">
                  {t.research.status[r.status]} · {when(r.created_at)} · {r.progress?.counts?.verified ?? 0} {A.metrics.verified.toLowerCase()}
                </span>
              </li>
            ))}
          </Paged>
        </div>
      )}
      <p className="text-sm text-muted">{A.detail.turnOnHelp}</p>
      <div className="flex flex-wrap items-center gap-4">
        <AgentPowerButton agentId={agent.id} status={agent.status} />
        {!running && <ArchiveButton agentId={agent.id} />}
      </div>
    </section>
  );
}
