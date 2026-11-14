import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeRun, RUN_COLUMNS, type RunRow } from "@/lib/research/rows";
import type { HunterSetup } from "./hunter";
import { AGENT_COLUMNS, type AgentPatch, type AgentRow, type AgentStatus } from "./types";

export interface AgentStore {
  insertDraft(a: { workspaceId: string; name: string; config: HunterSetup }): Promise<string>;
  getAgent(id: string): Promise<AgentRow | null>;
  updateAgent(id: string, patch: AgentPatch): Promise<void>;
  /** Not archived, newest first. */
  listAgents(workspaceId: string): Promise<AgentRow[]>;
  getSetupRun(agentId: string): Promise<RunRow | null>;
  /** Update only while the agent still has `expected` status. True when a row changed; database errors are rethrown with their message (A7, A8...). */
  updateAgentIf(id: string, expected: AgentStatus, patch: AgentPatch): Promise<boolean>;
  /** The agent's own runs (not the setup run), newest first, at most 52. */
  listRuns(agentId: string): Promise<RunRow[]>;
}

/** Production store: the logged-in user's session client, so RLS applies (owner/sdr only). */
export class SupabaseAgentStore implements AgentStore {
  constructor(private readonly db: SupabaseClient) {}

  private fail(what: string, error: { message: string } | null): never {
    throw new Error(`${what}: ${error?.message ?? "failed"}`);
  }

  async insertDraft(a: { workspaceId: string; name: string; config: HunterSetup }): Promise<string> {
    const { data, error } = await this.db
      .from("agents")
      .insert({ workspace_id: a.workspaceId, type: "hunter", name: a.name, config: a.config, schedule: "weekly" })
      .select("id")
      .single();
    if (error || !data) this.fail("insertDraft", error);
    return data.id as string;
  }

  async getAgent(id: string): Promise<AgentRow | null> {
    const { data, error } = await this.db.from("agents").select(AGENT_COLUMNS).eq("id", id).maybeSingle();
    if (error) this.fail("getAgent", error);
    return (data as AgentRow | null) ?? null;
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<void> {
    const { error } = await this.db.from("agents").update(patch).eq("id", id);
    if (error) this.fail("updateAgent", error);
  }

  async listAgents(workspaceId: string): Promise<AgentRow[]> {
    const { data, error } = await this.db
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .order("created_at", { ascending: false });
    if (error) this.fail("listAgents", error);
    return (data ?? []) as AgentRow[];
  }

  async getSetupRun(agentId: string): Promise<RunRow | null> {
    const { data, error } = await this.db.from("research_runs").select(RUN_COLUMNS).eq("setup_agent_id", agentId).maybeSingle();
    if (error) this.fail("getSetupRun", error);
    return data ? normalizeRun(data as Record<string, unknown>) : null;
  }

  async updateAgentIf(id: string, expected: AgentStatus, patch: AgentPatch): Promise<boolean> {
    const { data, error } = await this.db.from("agents").update(patch).eq("id", id).eq("status", expected).select("id");
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  }

  async listRuns(agentId: string): Promise<RunRow[]> {
    const { data, error } = await this.db
      .from("research_runs")
      .select(RUN_COLUMNS)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(52);
    if (error) this.fail("listRuns", error);
    return (data ?? []).map((r) => normalizeRun(r as Record<string, unknown>));
  }
}
