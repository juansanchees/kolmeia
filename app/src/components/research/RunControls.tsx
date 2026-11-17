"use client";

import { useState, useTransition } from "react";
import { controlResearch } from "@/app/(app)/agentes/actions";
import { useT } from "@/lib/i18n/client";
import { GhostButton } from "./controls";

export function RunControls({ runId, paused }: { runId: string; paused: boolean }) {
  const t = useT();
  const R = t.research.running;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: "pause" | "resume" | "cancel") =>
    start(async () => {
      if (action === "cancel" && !window.confirm(R.cancelConfirm)) return;
      const r = await controlResearch(runId, action);
      setError(r.status === "error" ? (r.message ?? null) : null);
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {paused ? (
        <GhostButton onClick={() => run("resume")} disabled={pending} className="border-ink">
          {R.resume}
        </GhostButton>
      ) : (
        <GhostButton onClick={() => run("pause")} disabled={pending}>
          {R.pause}
        </GhostButton>
      )}
      <GhostButton onClick={() => run("cancel")} disabled={pending}>
        {R.cancel}
      </GhostButton>
      {error && (
        <p role="alert" className="m-0 w-full text-base font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
