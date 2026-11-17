"use client";

import { useState, useTransition } from "react";
import { archiveAgentAction } from "@/app/(app)/agentes/agent-actions";
import { GhostButton } from "@/components/research/controls";
import { useT } from "@/lib/i18n/client";

export function ArchiveButton({ agentId }: { agentId: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      {asking ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t.agents.archiveConfirm}</span>
          <GhostButton
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await archiveAgentAction(agentId);
                if (r?.status === "error") {
                  setError(r.message ?? t.agents.hunter.errors.failed);
                  setAsking(false);
                }
              })
            }
          >
            {t.agents.archiveYes}
          </GhostButton>
          <GhostButton disabled={pending} onClick={() => setAsking(false)}>
            {t.agents.archiveNo}
          </GhostButton>
        </span>
      ) : (
        <GhostButton
          onClick={() => {
            setError(null);
            setAsking(true);
          }}
        >
          {t.agents.archive}
        </GhostButton>
      )}
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
