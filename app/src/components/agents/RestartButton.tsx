"use client";

import { useState, useTransition } from "react";
import { restartHunterAction } from "@/app/(app)/agentes/agent-actions";
import { PrimaryButton } from "@/components/research/controls";
import { useT } from "@/lib/i18n/client";

export function RestartButton({ agentId }: { agentId: string }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <PrimaryButton
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await restartHunterAction(agentId);
            if (r?.status === "error") setError(r.message ?? t.agents.hunter.errors.failed);
          })
        }
      >
        {t.agents.restart}
      </PrimaryButton>
      {error && (
        <span role="alert" className="text-base font-medium text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
