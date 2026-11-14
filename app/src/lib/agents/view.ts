import { t } from "@/messages/pt";
import type { AgentRow } from "./types";

export function agentRowView(a: AgentRow): { href: string; type: string; status: string; metric: string; cta: string } {
  const draft = a.status === "draft";
  return {
    href: `/agentes/${a.id}`,
    type: t.agents.types[a.type],
    status: t.agents.statuses[a.status],
    metric: draft ? t.agents.metric.draft : t.agents.metric.neverRan,
    cta: draft ? t.agents.continue : t.agents.open,
  };
}
