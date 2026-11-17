"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buildListAction, setCallAgentRunningAction } from "@/app/(app)/agentes/call-actions";
import { Badge, buttonClass, CountPill, EmptyState, HexPanel, Notice, StepTitle } from "@/components/ui";
import { InfoRow, Pill, powerClass } from "@/components/research/controls";
import { AgentHead, DlStat } from "./AgentHead";
import { TYPE_ICON } from "./type-icons";
import { ArchiveButton } from "./ArchiveButton";
import type { AgentRow } from "@/lib/agents/types";
import { callAgentConfigSchema } from "@/lib/calls/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { Paged } from "@/components/Pager";

export type CallDetailRow = { leadId: string; name: string; temperature: "very_hot" | "hot" | "warm" | "cold" | null; level: number; phone: string | null; outcome: string | null };

/** Ligação agent page: config, Ligar/Pausar, "Montar lista de hoje", the day's numbers and the list (read only). */
export function CallAgentDetail({
  agent,
  callerLabel,
  stats,
  rows,
}: {
  agent: AgentRow;
  callerLabel: string;
  stats: { inList: number; called: number; answered: number; meetings: number };
  rows: CallDetailRow[];
}) {
  const t = useT();
  const A = t.agents;
  const C = t.callAgent;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const cfg = callAgentConfigSchema.safeParse(agent.config);
  const running = agent.status === "running";
  const canPower = agent.status === "paused" || running;

  const run = (job: () => Promise<{ status: string; message?: string }>) =>
    start(async () => {
      setMsg(null);
      const r = await job();
      if (r.status === "error") setMsg({ tone: "warn", text: r.message ?? C.failed });
      else if (r.message) setMsg({ tone: "ok", text: r.message });
      router.refresh();
    });

  const temps = cfg.success && cfg.data.temperatures.length > 0 ? cfg.data.temperatures.map((x) => t.research.labels.temperatureTitle[x]).join(", ") : C.any;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <HexPanel as="section" aria-labelledby="agent-title" raised wrapClassName="k-in" className="flex flex-col gap-7 py-7">
        <AgentHead id="agent-title" name={agent.name} type="call" typeLabel={A.types.call} status={agent.status} statusLabel={A.statuses[agent.status]} />

        {cfg.success && (
          <div className="flex flex-col gap-3">
            <StepTitle n={1} as="h3">{A.detail.steps.setup}</StepTitle>
            <dl className="m-0 md:pl-[42px]">
              <InfoRow label={C.caller}>{callerLabel}</InfoRow>
              <InfoRow label={C.perDay}>{cfg.data.per_day}</InfoRow>
              <InfoRow label={C.minLevel}>{fill(C.levelOption, { n: cfg.data.min_level })}</InfoRow>
              <InfoRow label={C.temperatures}>{temps}</InfoRow>
            </dl>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <StepTitle n={cfg.success ? 2 : 1} as="h3" hint={!running ? C.buildNeedsRunning : undefined}>
            {A.detail.steps.power}
          </StepTitle>
          <div className="flex flex-col gap-3 md:pl-[42px]">
            <div className="flex flex-wrap items-center gap-3">
              {canPower && (
                <button type="button" disabled={pending} className={powerClass(running)} onClick={() => run(() => setCallAgentRunningAction(agent.id, !running))}>
                  {running ? A.detail.pause : A.detail.turnOn}
                </button>
              )}
              <button type="button" disabled={pending || !running} className={buttonClass("secondary")} onClick={() => run(() => buildListAction(agent.id))}>
                {C.build}
              </button>
              {agent.status !== "running" && <ArchiveButton agentId={agent.id} />}
            </div>
            {msg && <Notice tone={msg.tone} role={msg.tone === "warn" ? "alert" : "status"}>{msg.text}</Notice>}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <StepTitle n={cfg.success ? 3 : 2} as="h3">{A.detail.steps.numbers}</StepTitle>
          <dl className="m-0 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))] md:pl-[42px]">
            <DlStat label={C.metrics.inList} value={stats.inList} />
            <DlStat label={C.metrics.called} value={stats.called} />
            <DlStat label={C.metrics.answered} value={stats.answered} />
            <DlStat label={C.metrics.meetings} value={stats.meetings} />
          </dl>
        </div>
      </HexPanel>

      <HexPanel as="section" aria-labelledby="call-today" wrapClassName="k-in [animation-delay:.08s]" className="flex flex-col gap-3 py-6">
        <h3 id="call-today" className="flex items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">
          {t.calls.today} {rows.length > 0 && <CountPill>{rows.length}</CountPill>}
        </h3>
        {rows.length === 0 ? (
          <EmptyState icon={TYPE_ICON.call} title={t.calls.empty}>
            {running ? undefined : C.buildNeedsRunning}
          </EmptyState>
        ) : (
          <Paged as="ul" className="m-0 flex list-none flex-col gap-1 p-0">
            {rows.map((r) => (
              <li key={r.leadId}>
                <Link href={`/leads/${r.leadId}`} className="k-row flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] px-3.5 py-2.5 text-ink no-underline">
                  <span className="min-w-0 flex-[1_1_200px] font-semibold">{r.name}</span>
                  {r.temperature && <Pill tone={r.temperature}>{t.research.labels.temperature[r.temperature]}</Pill>}
                  <span className="font-mono text-sm text-[#4a5361]">{r.phone ?? C.noPhone}</span>
                  {r.outcome && <Badge tone="neutral" className="py-0.5">{t.calls.outcomes[r.outcome as keyof typeof t.calls.outcomes]}</Badge>}
                </Link>
              </li>
            ))}
          </Paged>
        )}
      </HexPanel>
    </div>
  );
}
