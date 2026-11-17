"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RunStatus } from "@/lib/research/types";
import type { Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

type StepReply = { outcome?: string; code?: string; status?: RunStatus; more?: boolean; error?: string };

const aiMessages = (t: Messages): Record<string, string> => ({
  not_configured: t.ai.notConfigured,
  no_access: t.ai.noAccess,
  daily_cap: t.ai.dailyCap,
  user_cap: t.ai.userCap,
  global_cap: t.ai.globalCap,
  run_time: t.ai.runTime,
  run_cap: t.ai.runCap,
  refused: t.ai.refused,
  invalid_output: t.ai.invalidOutput,
  truncated: t.ai.truncated,
  transport: t.ai.generic,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives a run while this page is open: asks the server for one bounded step, refreshes the page data, repeats.
 * Closing the page simply stops the loop; the run waits in the database and continues when someone comes back.
 */
export function RunDriver({ runId, status }: { runId: string; status: RunStatus }) {
  const t = useT();
  const router = useRouter();
  const [note, setNote] = useState<string>(status === "questions" ? t.research.conversation.thinking : t.research.running.working);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const ctl = new AbortController();
    (async () => {
      while (!stopped) {
        let reply: StepReply;
        try {
          const res = await fetch(`/api/research/${runId}/advance`, { method: "POST", signal: ctl.signal });
          if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
            setProblem(t.ai.generic);
            break;
          }
          reply = (await res.json()) as StepReply;
        } catch {
          if (stopped) break;
          setProblem(t.ai.generic);
          await sleep(5_000);
          continue;
        }
        if (stopped) break;
        router.refresh();
        if (reply.outcome === "busy") {
          setNote(t.research.running.busy);
          await sleep(5_000);
          continue;
        }
        if (reply.outcome === "ai_error") {
          setProblem(aiMessages(t)[reply.code ?? "transport"] ?? t.ai.generic);
          if (!reply.more) break;
          await sleep(3_000);
          continue;
        }
        setProblem(null);
        setNote(t.research.running.working);
        if (!reply.more) break;
        await sleep(600);
      }
    })();
    return () => {
      stopped = true;
      ctl.abort();
    };
    // t is left out on purpose: switching language must not restart the run loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, router]);

  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-mono text-xs text-blue-ink">
        <span aria-hidden="true" className="inline-block h-2 w-2 animate-pulse bg-blue" />
        {note}
      </p>
      {problem && (
        <p role="alert" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {problem}
        </p>
      )}
    </div>
  );
}
