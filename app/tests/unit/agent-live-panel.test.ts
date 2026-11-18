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
  test("one stage label per engine stage", () => {
    for (const s of STAGES) expect(pt.agents.live.stages).toHaveProperty(s);
  });
  test("mounted for non-draft agents; power button refreshes", () => {
    expect(read("src/components/agents/AgentDetail.tsx")).toContain("AgentLivePanel");
    expect(read("src/components/agents/AgentPowerButton.tsx")).toContain("router.refresh()");
  });
});
