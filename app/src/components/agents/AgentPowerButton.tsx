"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pauseHunterAction, turnOnHunterAction } from "@/app/(app)/agentes/agent-actions";
import { powerClass } from "@/components/research/controls";
import type { AgentStatus } from "@/lib/agents/types";
import { useT } from "@/lib/i18n/client";

/** "Ligar" (paused) / "Pausar" (running). Nothing else is offered: runs are never edited by hand. */
export function AgentPowerButton({ agentId, status }: { agentId: string; status: AgentStatus }) {
  const t = useT();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (status !== "paused" && status !== "running") return null;
  const running = status === "running";
  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={powerClass(running)}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await (running ? pauseHunterAction(agentId) : turnOnHunterAction(agentId));
            if (r?.status === "error") setError(r.message ?? t.agents.hunter.errors.failed);
            else router.refresh();
          })
        }
      >
        {pending ? t.agents.live.starting : running ? t.agents.detail.pause : t.agents.detail.turnOn}
      </button>
      {error && (
        <span role="alert" className="text-base font-medium text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
