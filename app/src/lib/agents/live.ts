import type { RunRow } from "@/lib/research/rows";

export type AgentLiveState = "idle" | "queued" | "running" | "paused" | "done" | "failed";
export type AgentLive = {
  state: AgentLiveState;
  /** Queued for more than 3 minutes with no run started. */
  stale: boolean;
  pausedReason: string | null;
  nextRunAt: string | null;
  run: null | {
    id: string; status: string; startedAt: string | null; finishedAt: string | null;
    stage: string | null; spentUsd: number; maxUsd: number | null; found: number; maxFound: number | null;
    lastName: string | null; error: string | null;
  };
};

export type LiveRun = Pick<
  RunRow,
  "id" | "status" | "started_at" | "finished_at" | "spent_cost_usd" | "max_cost_usd" | "max_candidates" | "progress" | "error"
>;

const STALE_MS = 3 * 60 * 1000;

/** Queued but the clock never started it: more than 3 minutes past next_run_at. */
export const isQueueStale = (nextRunAt: string | null, now: Date) =>
  nextRunAt !== null && now.getTime() - new Date(nextRunAt).getTime() > STALE_MS;

export function agentLiveView(input: {
  agent: { status: string; next_run_at: string | null; paused_reason: string | null };
  run: LiveRun | null;
  found: number;
  lastName: string | null;
  now: Date;
}): AgentLive {
  const { agent, run, found, lastName, now } = input;
  const due = agent.next_run_at !== null && new Date(agent.next_run_at).getTime() <= now.getTime();
  const live = run?.status === "ready" || run?.status === "running" || run?.status === "paused";

  let state: AgentLiveState = "idle";
  if (agent.status === "paused" || run?.status === "paused") state = "paused";
  else if (run?.status === "ready") state = "queued";
  else if (run?.status === "running") state = "running";
  else if (agent.status === "running" && due && !live) state = "queued";
  else if (run?.status === "done" || run?.status === "failed") state = run.status;

  const stale = state === "queued" && isQueueStale(agent.next_run_at, now);

  return {
    state,
    stale,
    pausedReason: state === "paused" ? (agent.paused_reason ?? run?.progress?.pauseReason ?? (agent.status === "paused" ? "user" : null)) : null,
    nextRunAt: agent.next_run_at,
    run: run && {
      id: run.id,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      stage: run.progress?.stage ?? null,
      spentUsd: Number(run.spent_cost_usd),
      maxUsd: run.max_cost_usd == null ? null : Number(run.max_cost_usd),
      found,
      maxFound: run.max_candidates ?? null,
      lastName,
      error: run.error,
    },
  };
}
