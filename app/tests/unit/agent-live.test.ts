import { describe, expect, test } from "vitest";
import { agentLiveView, type LiveRun } from "@/lib/agents/live";

const now = new Date("2026-11-17T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const agent = (o: Partial<{ status: string; next_run_at: string | null; paused_reason: string | null }> = {}) => ({
  status: "running", next_run_at: null, paused_reason: null, ...o,
});
const run = (o: Partial<LiveRun> = {}): LiveRun => ({
  id: "r1", status: "running", started_at: ago(60), finished_at: null, spent_cost_usd: 0.5, max_cost_usd: 2,
  max_candidates: 40, progress: {}, error: null, ...o,
});
const view = (a: ReturnType<typeof agent>, r: LiveRun | null) => agentLiveView({ agent: a, run: r, found: 3, lastName: "Acme", now });

describe("agentLiveView", () => {
  test("agent paused -> paused with agent reason", () => {
    const v = view(agent({ status: "paused", paused_reason: "user" }), null);
    expect(v.state).toBe("paused");
    expect(v.pausedReason).toBe("user");
  });
  test("run paused by cap -> reason from progress", () => {
    const v = view(agent(), run({ status: "paused", progress: { pauseReason: "daily_cap" } }));
    expect(v.state).toBe("paused");
    expect(v.pausedReason).toBe("daily_cap");
  });
  test("run ready -> queued; running -> running", () => {
    expect(view(agent(), run({ status: "ready" })).state).toBe("queued");
    const v = view(agent(), run({ progress: { stage: "collect" } }));
    expect(v.state).toBe("running");
    expect(v.run?.stage).toBe("collect");
    expect(v.run).toMatchObject({ found: 3, lastName: "Acme", maxFound: 40, maxUsd: 2 });
  });
  test("agent running, due, no live run -> queued", () => {
    expect(view(agent({ next_run_at: ago(10) }), null).state).toBe("queued");
    expect(view(agent({ next_run_at: ago(10) }), run({ status: "done" })).state).toBe("queued");
  });
  test("not yet due -> done / failed / idle", () => {
    const future = new Date(now.getTime() + 60000).toISOString();
    expect(view(agent({ next_run_at: future }), run({ status: "done" })).state).toBe("done");
    expect(view(agent({ next_run_at: future }), run({ status: "failed", error: "x" })).state).toBe("failed");
    expect(view(agent({ next_run_at: future }), null).state).toBe("idle");
  });
  test("stale only after 3 min", () => {
    expect(view(agent({ next_run_at: ago(179) }), null).stale).toBe(false);
    expect(view(agent({ next_run_at: ago(181) }), null).stale).toBe(true);
    expect(view(agent({ next_run_at: ago(181) }), run()).stale).toBe(false);
  });
  test("money as numbers from PostgREST strings", () => {
    const v = view(agent(), run({ spent_cost_usd: "0.75" as unknown as number, max_cost_usd: "2.00" as unknown as number }));
    expect(v.run?.spentUsd).toBe(0.75);
    expect(v.run?.maxUsd).toBe(2);
  });
});
