import { when } from "@/components/email/format";
import type { RunRow } from "@/lib/research/rows";
import type { Messages } from "@/lib/i18n";
import type { AgentRow } from "./types";

function metricOf(a: AgentRow, now: Date, t: Messages, listSize?: number): string {
  // A call agent has no runs: its number is the size of today's list (when the page knows it).
  if (a.type === "call" && listSize !== undefined && a.status !== "draft") return `${listSize} ${t.callAgent.metrics.inList}`;
  switch (a.status) {
    case "draft":
      return t.agents.metric.draft;
    case "running":
      return a.next_run_at && new Date(a.next_run_at).getTime() > now.getTime()
        ? t.agents.detail.nextRun.replace("{when}", when(a.next_run_at, t.intl))
        : t.agents.metric.searching;
    case "paused":
      return a.paused_reason ? t.agents.paused[a.paused_reason] : a.next_run_at ? t.agents.metric.pausedByYou : t.agents.metric.neverRan;
    case "done":
      return t.agents.metric.done;
  }
}

export function agentRowView(a: AgentRow, now: Date, t: Messages, opts: { listSize?: number } = {}): { href: string; type: string; status: string; metric: string; cta: string } {
  return {
    href: `/agentes/${a.id}`,
    type: t.agents.types[a.type],
    status: t.agents.statuses[a.status],
    metric: metricOf(a, now, t, opts.listSize),
    cta: a.status === "draft" ? t.agents.continue : t.agents.open,
  };
}

/** Totals over an agent's runs (from each run's stage counts) plus what the setup cost. */
export function agentMetrics(runs: RunRow[], setupCostUsd: number): { runs: number; found: number; verified: number; refuted: number; costUsd: number } {
  let found = 0;
  let verified = 0;
  let refuted = 0;
  let costUsd = setupCostUsd;
  for (const r of runs) {
    const c = r.progress?.counts;
    found += c?.candidates ?? 0;
    verified += c?.verified ?? 0;
    refuted += c?.refuted ?? 0;
    costUsd += r.spent_cost_usd ?? 0;
  }
  return { runs: runs.length, found, verified, refuted, costUsd };
}
