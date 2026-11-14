import { describe, expect, test } from "vitest";
import { defaultAgentName, hunterConfig, hunterFinishSchema, hunterRequest, hunterSetupSchema, regionOptions, type HunterSetup } from "@/lib/agents/hunter";
import { hunterStep } from "@/lib/agents/steps";
import { agentRowView } from "@/lib/agents/view";
import type { AgentRow } from "@/lib/agents/types";
import { DEFAULT_CAPS } from "@/lib/research/types";
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
      next_run_at: null, archived_at: null, created_at: "", updated_at: "", ...o,
    });
    expect(agentRowView(row({}))).toMatchObject({ status: "rascunho", metric: t.agents.metric.draft, cta: "Continuar", href: "/agentes/a1" });
    expect(agentRowView(row({ status: "paused" }))).toMatchObject({ type: "Caçador", status: "pausado", metric: t.agents.metric.neverRan, cta: "Abrir" });
  });
});
