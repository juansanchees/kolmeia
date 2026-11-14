"use client";

import { useState, useTransition } from "react";
import { controlResearch } from "@/app/(app)/agentes/actions";
import { t } from "@/messages/pt";
import { GhostButton } from "./controls";

const R = t.research.running;

export function RunControls({ runId, paused }: { runId: string; paused: boolean }) {
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
        <GhostButton onClick={() => run("resume")} disabled={pending} className="border-blue text-blue">
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
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
