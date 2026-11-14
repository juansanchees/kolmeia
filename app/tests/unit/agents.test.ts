import { describe, expect, test } from "vitest";
import { defaultAgentName, hunterConfig, hunterFinishSchema, hunterRequest, hunterSetupSchema, regionOptions, type HunterSetup } from "@/lib/agents/hunter";
import { hunterStep } from "@/lib/agents/steps";
import { agentMetrics, agentRowView } from "@/lib/agents/view";
import type { AgentRow } from "@/lib/agents/types";
import type { RunRow } from "@/lib/research/rows";
import { DEFAULT_CAPS } from "@/lib/research/types";
import { when } from "@/components/email/format";
import { t } from "@/messages/pt";

const base: HunterSetup = { profileSource: "saved", companyNote: "", audience: "builder", audienceText: "", region: "Boston" };
const issuePaths = (r: ReturnType<typeof hunterSetupSchema.safeParse>) => (r.success ? [] : r.error.issues.map((i) => i.path.join(".")));

describe("F2 agents", () => {
  test("hunter setup: describe needs a note, other needs a text, region is required and bounded", () => {
    expect(issuePaths(hunterSetupSchema.safeParse({ ...base, profileSource: "describe", companyNote: "" }))).toContain("companyNote");
    expect(issuePaths(hunterSetupSchema.safeParse({ ...base, audience: "other", audienceText: "  " }))).toContain("audienceText");
    expect(issuePaths(hunterSetupSchema.safeParse({ ...base, region: "" }))).toContain("region");
    expect(issuePaths(hunterSetupSchema.safeParse({ ...base, region: "x".repeat(1001) }))).toContain("region");
    expect(hunterSetupSchema.safeParse(base).success).toBe(true);
  });

  test("hunterRequest builds the research request from the answers", () => {
    expect(hunterRequest(base)).toBe("Achar construtores");
    expect(hunterRequest({ ...base, audience: "other", audienceText: "GCs comerciais" })).toBe("Achar GCs comerciais");
    expect(hunterRequest({ ...base, audience: "property_manager", profileSource: "describe", companyNote: "Fazemos HVAC" })).toBe(
      "Achar administradoras\n\nSobre a nossa empresa: Fazemos HVAC",
    );
    const big = hunterSetupSchema.parse({ profileSource: "describe", companyNote: "n".repeat(1400), audience: "other", audienceText: "a".repeat(500), region: "r" });
    expect(hunterRequest(big).length).toBeLessThanOrEqual(2000);
  });

  test("regionOptions clips the profile area; defaultAgentName never passes 80 characters", () => {
    expect(regionOptions("")).toEqual([]);
    expect(regionOptions("  Boston  ")).toEqual(["Boston"]);
    const opts = regionOptions("z".repeat(2000));
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveLength(1000);
    expect(defaultAgentName(base)).toBe("Caçador Construtores Boston");
    const long = defaultAgentName({ ...base, region: "y".repeat(1000) });
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });

  test("hunterConfig copies the run's region and the rigor's default caps", () => {
    const c = hunterConfig(base, { name: "x", rigor: "strict", schedule: "daily" }, "Cape Cod");
    expect(c.region).toBe("Cape Cod");
    expect(c.rigor).toBe("strict");
    expect(c.caps).toEqual(DEFAULT_CAPS.strict);
    expect(hunterFinishSchema.safeParse({ name: "", rigor: "quick", schedule: "once" }).success).toBe(false);
  });

  test("hunterStep: which part of the chat to show", () => {
    const q = [{ id: "a" }] as never;
    const plan = { summary: "s" } as never;
    const d = { status: "draft" } as const;
    const run = (status: string, questions: unknown = null, p: unknown = null) => ({ status, questions, plan: p }) as never;
    expect(hunterStep({ status: "paused" }, null, true)).toBe("created");
    expect(hunterStep(d, null, true)).toBe("setup_failed");
    expect(hunterStep(d, run("failed"), true)).toBe("setup_failed");
    expect(hunterStep(d, run("cancelled"), true)).toBe("setup_failed");
    expect(hunterStep(d, run("ready"), true)).toBe("setup_failed");
    expect(hunterStep(d, run("questions"), true)).toBe("thinking");
    expect(hunterStep(d, run("questions", q), true)).toBe("questions");
    expect(hunterStep(d, run("plan"), true)).toBe("planning");
    expect(hunterStep(d, run("plan", q, plan), true)).toBe("choose");
  });

  test("hunterStep without AI waits as a draft instead of failing", () => {
    const q = [{ id: "a" }] as never;
    const d = { status: "draft" } as const;
    const run = (status: string, questions: unknown = null, p: unknown = null) => ({ status, questions, plan: p }) as never;
    expect(hunterStep(d, run("questions"), false)).toBe("no_ai");
    expect(hunterStep(d, run("plan", q), false)).toBe("no_ai");
    expect(hunterStep(d, run("questions", q), false)).toBe("questions");
    expect(hunterStep(d, run("plan", q, { summary: "s" }), false)).toBe("choose");
  });

  test("agentRowView: draft continues, paused hunter has not run yet", () => {
    const row = (o: Partial<AgentRow>): AgentRow => ({
      id: "a1", workspace_id: "w", type: "hunter", name: "N", status: "draft", config: {}, schedule: "weekly",
      next_run_at: null, paused_reason: null, archived_at: null, created_at: "", updated_at: "", ...o,
    });
    const now = new Date("2026-11-14T12:00:00Z");
    expect(agentRowView(row({}), now)).toMatchObject({ status: "rascunho", metric: t.agents.metric.draft, cta: "Continuar", href: "/agentes/a1" });
    expect(agentRowView(row({ status: "paused" }), now)).toMatchObject({ type: "Caçador", status: "pausado", metric: t.agents.metric.neverRan, cta: "Abrir" });
  });

  test("agentRowView: next search, searching now, the pause reason, done", () => {
    const row = (o: Partial<AgentRow>): AgentRow => ({
      id: "a1", workspace_id: "w", type: "hunter", name: "N", status: "running", config: {}, schedule: "weekly",
      next_run_at: null, paused_reason: null, archived_at: null, created_at: "", updated_at: "", ...o,
    });
    const now = new Date("2026-11-14T12:00:00Z");
    const future = "2026-11-21T12:00:00Z";
    expect(agentRowView(row({ next_run_at: future }), now).metric).toBe(t.agents.detail.nextRun.replace("{when}", when(future)));
    expect(agentRowView(row({ next_run_at: "2026-11-14T11:00:00Z" }), now).metric).toBe(t.agents.metric.searching);
    expect(agentRowView(row({ next_run_at: null }), now).metric).toBe(t.agents.metric.searching);
    expect(agentRowView(row({ status: "paused", paused_reason: "daily_cap" }), now).metric).toBe(t.agents.paused.daily_cap);
    expect(agentRowView(row({ status: "paused", paused_reason: "error" }), now).metric).toBe(t.agents.paused.error);
    expect(agentRowView(row({ status: "paused" }), now).metric).toBe(t.agents.metric.neverRan);
    expect(agentRowView(row({ status: "paused", next_run_at: "2026-11-10T12:00:00Z" }), now).metric).toBe(t.agents.metric.pausedByYou);
    expect(agentRowView(row({ status: "done" }), now).metric).toBe(t.agents.metric.done);
  });

  test("agentMetrics sums runs, companies, verified, refuted and AI cost with the setup", () => {
    const run = (candidates: number, verified: number, refuted: number, cost: number) =>
      ({ spent_cost_usd: cost, progress: { counts: { candidates, verified, refuted } } }) as unknown as RunRow;
    const m = agentMetrics([run(20, 18, 2, 2.1), run(5, 5, 0, 0.4)], 0.3);
    expect(m).toMatchObject({ runs: 2, found: 25, verified: 23, refuted: 2 });
    expect(m.costUsd).toBeCloseTo(2.8, 10);
    expect(agentMetrics([{ spent_cost_usd: 1, progress: {} } as unknown as RunRow], 0)).toEqual({ runs: 1, found: 0, verified: 0, refuted: 0, costUsd: 1 });
  });
});
