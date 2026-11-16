"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buildListAction, setCallAgentRunningAction } from "@/app/(app)/agentes/call-actions";
import { btn, Notice } from "@/components/email/bits";
import { Pill } from "@/components/research/controls";
import { ArchiveButton } from "./ArchiveButton";
import type { AgentRow } from "@/lib/agents/types";
import { callAgentConfigSchema } from "@/lib/calls/types";
import { fill, t } from "@/messages/pt";
import { Paged } from "@/components/Pager";

const A = t.agents;
const C = t.callAgent;

export type CallDetailRow = { leadId: string; name: string; temperature: "very_hot" | "hot" | "warm" | "cold" | null; level: number; phone: string | null; outcome: string | null };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 border-t border-line py-2 text-sm sm:grid-cols-[14rem_1fr]">
      <dt className="font-mono text-xs text-muted">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

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
    <section aria-labelledby="agent-title" className="flex flex-col gap-4 border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <h2 id="agent-title" className="text-2xl">
          {agent.name}
        </h2>
        <span className="font-mono text-xs text-muted">
          {A.types.call} · <span className="border border-line px-2 py-0.5">{A.statuses[agent.status]}</span>
        </span>
      </div>

      {cfg.success && (
        <dl className="m-0">
          <Row label={C.caller}>{callerLabel}</Row>
          <Row label={C.perDay}>{cfg.data.per_day}</Row>
          <Row label={C.minLevel}>{fill(C.levelOption, { n: cfg.data.min_level })}</Row>
          <Row label={C.temperatures}>{temps}</Row>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canPower && (
          <button type="button" disabled={pending} className={running ? btn.ghost : btn.primary} onClick={() => run(() => setCallAgentRunningAction(agent.id, !running))}>
            {running ? A.detail.pause : A.detail.turnOn}
          </button>
        )}
        <button type="button" disabled={pending || !running} className={btn.ghost} onClick={() => run(() => buildListAction(agent.id))}>
          {C.build}
        </button>
        {agent.status !== "running" && <ArchiveButton agentId={agent.id} />}
      </div>
      {!running && <p className="text-sm text-muted">{C.buildNeedsRunning}</p>}
      {msg && <Notice tone={msg.tone} role={msg.tone === "warn" ? "alert" : "status"}>{msg.text}</Notice>}

      <dl className="m-0">
        <Row label={C.metrics.inList}>{stats.inList}</Row>
        <Row label={C.metrics.called}>{stats.called}</Row>
        <Row label={C.metrics.answered}>{stats.answered}</Row>
        <Row label={C.metrics.meetings}>{stats.meetings}</Row>
      </dl>

      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{t.calls.today}</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t.calls.empty}</p>
        ) : (
          <Paged as="ul" className="m-0 flex list-none flex-col p-0">
            {rows.map((r) => (
              <li key={r.leadId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 text-sm">
                <Link href={`/leads/${r.leadId}`} className="font-semibold text-ink underline-offset-4 hover:underline">
                  {r.name}
                </Link>
                {r.temperature && <Pill tone={r.temperature}>{t.research.labels.temperature[r.temperature]}</Pill>}
                <span className="font-mono text-xs text-muted">{r.phone ?? C.noPhone}</span>
                {r.outcome && <span className="font-mono text-xs text-muted">{t.calls.outcomes[r.outcome as keyof typeof t.calls.outcomes]}</span>}
              </li>
            ))}
          </Paged>
        )}
      </div>
    </section>
  );
}
