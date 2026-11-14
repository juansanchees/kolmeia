import type { RunRow } from "@/lib/research/rows";
import type { AgentRow } from "./types";

export type HunterStep = "thinking" | "questions" | "planning" | "choose" | "no_ai" | "setup_failed" | "created";

/** Which part of the Caçador chat to show. Work already done always shows, even without an AI key. */
export function hunterStep(agent: Pick<AgentRow, "status">, run: Pick<RunRow, "status" | "questions" | "plan"> | null, ai: boolean): HunterStep {
  if (agent.status !== "draft") return "created";
  if (!run) return "setup_failed";
  if (run.status === "questions") {
    if (run.questions && run.questions.length > 0) return "questions";
    return ai ? "thinking" : "no_ai";
  }
  if (run.status === "plan") {
    if (run.plan) return "choose";
    return ai ? "planning" : "no_ai";
  }
  return "setup_failed";
}
