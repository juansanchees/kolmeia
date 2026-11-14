"use client";

import { useState, useTransition } from "react";
import { archiveAgentAction } from "@/app/(app)/agentes/agent-actions";
import { GhostButton } from "@/components/research/controls";
import { t } from "@/messages/pt";

export function ArchiveButton({ agentId }: { agentId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <GhostButton
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await archiveAgentAction(agentId);
            if (r?.status === "error") setError(r.message ?? t.agents.hunter.errors.failed);
          })
        }
      >
        {t.agents.archive}
      </GhostButton>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
