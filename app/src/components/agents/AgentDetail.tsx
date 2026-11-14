import { usd } from "@/components/research/format";
import type { RunRow } from "@/lib/research/rows";
import type { AgentRow } from "@/lib/agents/types";
import { t } from "@/messages/pt";
import { ArchiveButton } from "./ArchiveButton";

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

export function AgentDetail({ agent, setupRun }: { agent: AgentRow; setupRun: RunRow | null }) {
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
      <p className="text-sm text-muted">{A.detail.turnOnSoon}</p>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" disabled className="min-h-11 border border-edge px-4 text-[15px] font-semibold text-muted opacity-60">
          {A.detail.turnOn}
        </button>
        <ArchiveButton agentId={agent.id} />
      </div>
    </section>
  );
}
