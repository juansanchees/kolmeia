export const AGENT_TYPES = ["hunter", "email", "call"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_STATUSES = ["draft", "paused", "running", "done"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const SCHEDULES = ["once", "weekly", "daily"] as const;
export type Schedule = (typeof SCHEDULES)[number];

export type AgentRow = {
  id: string;
  workspace_id: string;
  type: AgentType;
  name: string;
  status: AgentStatus;
  config: Record<string, unknown>;
  schedule: Schedule;
  next_run_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentPatch = Partial<Pick<AgentRow, "name" | "status" | "config" | "schedule" | "archived_at">>;

export const AGENT_COLUMNS = "id, workspace_id, type, name, status, config, schedule, next_run_at, archived_at, created_at, updated_at";
