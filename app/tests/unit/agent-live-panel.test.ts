import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { pt } from "@/messages/pt";
import { STAGES } from "@/lib/research/types";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const src = read("src/components/agents/AgentLivePanel.tsx");

describe("AgentLivePanel (source)", () => {
  test("polling constants and visibility handling", () => {
    expect(src).toContain("export const LIVE_FAST_MS = 3000");
    expect(src).toContain("export const LIVE_SLOW_MS = 30000");
    expect(src).toContain("visibilitychange");
    expect(src).toContain("document.hidden");
    expect(src).toContain("AbortController");
  });
  test("announces politely, refreshes on done, never renders run.error", () => {
    expect(src).toContain('aria-live="polite"');
    expect(src).toContain("router.refresh()");
    expect(src).not.toMatch(/\br\.error\b|run\.error/);
  });
  test("run button only while the agent is paused or running (never for a done agent)", () => {
    const d = read("src/components/agents/AgentDetail.tsx");
    expect(d).toContain('canRun={agent.status === "paused" || agent.status === "running"}');
    expect(d).not.toMatch(/canRun\s*\/>/);
  });
  test("refreshes on any exit from busy, backs off on non-ok, live region is narrow", () => {
    expect(src).toContain("!fast) router.refresh()");
    expect(src).toContain("ctl.signal.aborted");
    expect(src).not.toContain('<div aria-live="polite"');
    expect(src).toContain("ring-honey");
  });
  test("power button shows a pause-specific pending label", () => {
    expect(read("src/components/agents/AgentPowerButton.tsx")).toContain("t.agents.live.pausing");
  });
  test("one stage label per engine stage", () => {
    for (const s of STAGES) expect(pt.agents.live.stages).toHaveProperty(s);
  });
  test("mounted for non-draft agents; power button refreshes", () => {
    expect(read("src/components/agents/AgentDetail.tsx")).toContain("AgentLivePanel");
    expect(read("src/components/agents/AgentPowerButton.tsx")).toContain("router.refresh()");
  });
});
