import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { callAgentConfigSchema } from "@/lib/calls/types";
import { agentRowView } from "@/lib/agents/view";
import type { AgentRow } from "@/lib/agents/types";
import { t } from "@/messages/pt";

const CALLER = "30000000-0000-4000-8000-000000000003";
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

function agent(over: Partial<AgentRow>): AgentRow {
  return {
    id: "a1",
    workspace_id: "w1",
    type: "call",
    name: "Ligação diária",
    status: "paused",
    config: {},
    schedule: "daily",
    next_run_at: null,
    paused_reason: null,
    archived_at: null,
    created_at: "2026-11-15T10:00:00Z",
    updated_at: "2026-11-15T10:00:00Z",
    ...over,
  };
}

describe("F5 call agent (UI)", () => {
  test("the call agent config: defaults, ranges, unknown keys refused", () => {
    expect(callAgentConfigSchema.parse({ caller_id: CALLER })).toEqual({ caller_id: CALLER, per_day: 20, min_level: 1, temperatures: [] });
    expect(callAgentConfigSchema.safeParse({ caller_id: CALLER, per_day: 0 }).success).toBe(false);
    expect(callAgentConfigSchema.safeParse({ caller_id: CALLER, per_day: 51 }).success).toBe(false);
    expect(callAgentConfigSchema.safeParse({ caller_id: CALLER, min_level: 5 }).success).toBe(false);
    expect(callAgentConfigSchema.safeParse({ caller_id: CALLER, temperatures: ["lukewarm"] }).success).toBe(false);
    expect(callAgentConfigSchema.safeParse({ caller_id: CALLER, extra: 1 }).success).toBe(false);
    expect(callAgentConfigSchema.safeParse({ per_day: 5 }).success).toBe(false);
  });

  test("the gallery creates Ligação and keeps AI calling off", () => {
    const gallery = read("src/components/agents/AgentGallery.tsx");
    expect(gallery).toContain("CallAgentForm");
    expect(gallery).toContain("G.aiCall");
    expect(gallery).not.toContain("G.soon"); // the E-mail card is active since F4
    expect(t.agents.gallery.aiCall).toMatch(/em breve/i);
    // the Ligação card is no longer greyed out
    const callCard = gallery.slice(gallery.indexOf("t.agents.types.call"));
    expect(callCard.slice(0, callCard.indexOf("</Card>"))).not.toContain("off");
  });

  test("the list page builds the caller's lists and reads only through RLS", () => {
    const page = read("src/app/(app)/leads/ligar/page.tsx");
    expect(page).toContain("build_my_call_lists");
    expect(page).not.toMatch(/service|admin/i);
    expect(page).not.toContain("sms:");
    const q = read("src/lib/calls/list-queries.ts");
    expect(q).not.toMatch(/service|admin/i);
  });

  test("agentRowView shows the list size for a call agent", () => {
    expect(agentRowView(agent({}), new Date(), { listSize: 7 })).toMatchObject({ type: "Ligação", metric: "7 na lista", href: "/agentes/a1" });
    expect(agentRowView(agent({ status: "running" }), new Date(), { listSize: 0 }).metric).toBe("0 na lista");
    // without a number it falls back to the status line
    expect(agentRowView(agent({}), new Date()).metric).toBe(t.agents.metric.neverRan);
  });

  test("the call agent strings exist", () => {
    expect(t.callAgent.defaultName).toBe("Ligação diária");
    expect(t.callAgent.metrics.inList).toBe("na lista");
  });
});
