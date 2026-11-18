import { when } from "@/components/email/format";
import type { RunRow } from "@/lib/research/rows";
import type { Messages } from "@/lib/i18n";
import type { AgentRow } from "./types";
import { isQueueStale } from "./live";

export type LastRun = { status: string; finishedAt: string | null; found: number };

/** "há 2 h" / "2 hr. ago": largest whole unit, at least one minute. */
function ago(iso: string, now: Date, intl: string): string {
  const mins = Math.max(1, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  const rtf = new Intl.RelativeTimeFormat(intl, { numeric: "always", style: "short" });
  if (mins < 60) return rtf.format(-mins, "minute");
  if (mins < 1440) return rtf.format(-Math.floor(mins / 60), "hour");
  return rtf.format(-Math.floor(mins / 1440), "day");
}

function metricOf(a: AgentRow, now: Date, t: Messages, listSize?: number, lastRun?: LastRun): string {
  // A call agent has no runs: its number is the size of today's list (when the page knows it).
  if (a.type === "call" && listSize !== undefined && a.status !== "draft") return `${listSize} ${t.callAgent.metrics.inList}`;
  switch (a.status) {
    case "draft":
      return t.agents.metric.draft;
    case "running": {
      if (lastRun?.status === "paused") return t.agents.live.states.paused;
      if (lastRun?.status === "running") return t.agents.metric.working;
      const due = a.next_run_at !== null && new Date(a.next_run_at).getTime() <= now.getTime();
      const live = lastRun?.status === "ready" || lastRun?.status === "paused";
      if (a.type === "hunter" && (lastRun?.status === "ready" || (due && !live))) return isQueueStale(a.next_run_at, now) ? t.agents.metric.queuedStale : t.agents.metric.queued;
      if (lastRun?.status === "done" && lastRun.finishedAt) return t.agents.metric.ranAgo.replace("{ago}", ago(lastRun.finishedAt, now, t.intl)).replace("{n}", String(lastRun.found));
      return a.next_run_at && new Date(a.next_run_at).getTime() > now.getTime()
        ? t.agents.detail.nextRun.replace("{when}", when(a.next_run_at, t.intl))
        : t.agents.metric.searching;
    }
    case "paused":
      return a.paused_reason ? t.agents.paused[a.paused_reason] : a.next_run_at ? t.agents.metric.pausedByYou : t.agents.metric.neverRan;
    case "done":
      return t.agents.metric.done;
  }
}

export function agentRowView(a: AgentRow, now: Date, t: Messages, opts: { listSize?: number; lastRun?: LastRun } = {}): { href: string; type: string; status: string; metric: string; cta: string } {
  return {
    href: `/agentes/${a.id}`,
    type: t.agents.types[a.type],
    status: t.agents.statuses[a.status],
    metric: metricOf(a, now, t, opts.listSize, opts.lastRun),
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
