// Pure commands of the AGENTES area (no server imports): the server actions wrap these with the session.
import { createRun, pauseRun } from "@/lib/research/commands";
import type { ResearchStore } from "@/lib/research/store";
import { isSender, type Role } from "@/lib/roles";
import { defaultAgentName, hunterConfig, hunterFinishSchema, hunterRequest, hunterSetupSchema } from "./hunter";
import type { AgentStore } from "./store";

export type Actor = { workspaceId: string; role: Role };

export type CommandResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: "forbidden" | "not_found" | "not_ready" | "invalid" | "generic" | "too_many" | "running"; fieldErrors?: Record<string, string> };

/** Draft agent + its setup research (the normal research row, linked by setup_agent_id). */
export async function startHunter(agents: AgentStore, research: ResearchStore, actor: Actor, raw: unknown): Promise<CommandResult<{ agentId: string }>> {
  if (!isSender(actor.role)) return { ok: false, error: "forbidden" };
  const parsed = hunterSetupSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message;
    return { ok: false, error: "invalid", fieldErrors };
  }
  const setup = parsed.data;
  let agentId: string;
  try {
    agentId = await agents.insertDraft({ workspaceId: actor.workspaceId, name: defaultAgentName(setup), config: setup });
  } catch {
    return { ok: false, error: "generic" };
  }
  try {
    await createRun(research, actor.workspaceId, { request: hunterRequest(setup), region: setup.region, rigor: "careful" }, agentId);
  } catch {
    return { ok: false, error: "generic" }; // the draft stays: its page shows "setup_failed" -> "Recomeçar"
  }
  return { ok: true, agentId };
}

export async function archiveAgent(agents: AgentStore, actor: Actor, agentId: string): Promise<CommandResult> {
  if (!isSender(actor.role)) return { ok: false, error: "forbidden" };
  let agent;
  try {
    agent = await agents.getAgent(agentId);
  } catch {
    return { ok: false, error: "generic" };
  }
  if (!agent || agent.workspace_id !== actor.workspaceId) return { ok: false, error: "not_found" };
  if (agent.status === "running") return { ok: false, error: "running" }; // A8: pause first (the database refuses too)
  try {
    await agents.updateAgent(agentId, { archived_at: new Date().toISOString() });
  } catch (e) {
    return { ok: false, error: e instanceof Error && /A8/.test(e.message) ? "running" : "generic" }; // a second tab turned it on meanwhile
  }
  return { ok: true };
}

/**
 * Review card -> "Criar agente (pausado)": the only transition is draft -> paused, and only once the setup run has a plan.
 * Idempotent: a second click (or a second tab) finds a non-draft agent and changes nothing.
 */
export async function finishHunter(agents: AgentStore, actor: Actor, agentId: string, raw: unknown): Promise<CommandResult> {
  if (!isSender(actor.role)) return { ok: false, error: "forbidden" };
  let agent;
  let run;
  try {
    agent = await agents.getAgent(agentId);
    if (!agent || agent.workspace_id !== actor.workspaceId || agent.archived_at) return { ok: false, error: "not_found" };
    if (agent.status !== "draft") return { ok: true };
    const parsed = hunterFinishSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const i of parsed.error.issues) fieldErrors[String(i.path[0] ?? "form")] ??= i.message;
      return { ok: false, error: "invalid", fieldErrors };
    }
    const setup = hunterSetupSchema.safeParse(agent.config);
    if (!setup.success) return { ok: false, error: "generic" };
    run = await agents.getSetupRun(agentId);
    if (!run || run.status !== "plan" || !run.plan) return { ok: false, error: "not_ready" };
    // Only while still a draft: a second tab that already moved the agent on is not overwritten (false -> nothing to do).
    await agents.updateAgentIf(agentId, "draft", {
      name: parsed.data.name,
      status: "paused",
      schedule: parsed.data.schedule,
      config: hunterConfig(setup.data, parsed.data, run.region_text),
    });
  } catch {
    return { ok: false, error: "generic" };
  }
  return { ok: true };
}

async function loadOwned(agents: AgentStore, actor: Actor, agentId: string) {
  try {
    const agent = await agents.getAgent(agentId);
    if (!agent || agent.workspace_id !== actor.workspaceId || agent.archived_at) return { error: "not_found" as const };
    return { agent };
  } catch {
    return { error: "generic" as const };
  }
}

/** "Ligar": paused -> running. The database enforces the limit of 3 running hunters (A7). */
export async function turnOnHunter(agents: AgentStore, actor: Actor, agentId: string): Promise<CommandResult> {
  if (!isSender(actor.role)) return { ok: false, error: "forbidden" };
  const l = await loadOwned(agents, actor, agentId);
  if (!l.agent) return { ok: false, error: l.error };
  if (l.agent.type !== "hunter") return { ok: false, error: "not_ready" };
  if (l.agent.status === "running") return { ok: true };
  if (l.agent.status !== "paused") return { ok: false, error: "not_ready" };
  try {
    await agents.updateAgentIf(agentId, "paused", { status: "running" });
  } catch (e) {
    return { ok: false, error: e instanceof Error && /A7/.test(e.message) ? "too_many" : "generic" };
  }
  return { ok: true };
}

/** "Pausar": running -> paused, then the agent's running research is paused by the user (a step in flight finishes; none starts). */
export async function pauseHunter(agents: AgentStore, research: ResearchStore, actor: Actor, agentId: string): Promise<CommandResult> {
  if (!isSender(actor.role)) return { ok: false, error: "forbidden" };
  const l = await loadOwned(agents, actor, agentId);
  if (!l.agent) return { ok: false, error: l.error };
  try {
    if (!(await agents.updateAgentIf(agentId, "running", { status: "paused" }))) return { ok: true }; // already paused/done elsewhere
    const run = (await agents.listRuns(agentId)).find((r) => r.status === "running");
    if (run) await pauseRun(research, run);
  } catch {
    return { ok: false, error: "generic" };
  }
  return { ok: true };
}
