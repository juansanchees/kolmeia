import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hasAi } from "@/lib/ai/config";
import { needsAdvance } from "@/lib/research/engine";
import { researchSession } from "@/lib/research/session";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Conversation } from "@/components/research/Conversation";
import { Progress } from "@/components/research/Progress";
import { Results } from "@/components/research/Results";
import { RunDriver } from "@/components/research/RunDriver";
import { getT } from "@/lib/i18n/server";
import { buttonClass, EmptyState, Notice } from "@/components/ui";

// The step route runs up to 300 s; server actions on this page are short, but keep the same ceiling.
export const maxDuration = 300;

export default async function ResearchRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const t = await getT();
  const M = t.research;
  const { id } = await params;
  const { view } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await researchSession();
  if (!s) notFound();
  const run = await s.store.getRun(id);
  if (!run) notFound();
  if (run.setup_agent_id) redirect(`/agentes/${run.setup_agent_id}`); // a setup run is never opened as a search

  const ai = hasAi();
  const talking = run.status === "questions" || run.status === "plan" || run.status === "ready";
  const showConversation = talking || view === "conversa";
  const searching = run.status === "running" || run.status === "paused";
  const [sources, candidates, checks, jobs] =
    searching || run.status === "done" || run.status === "failed" || run.status === "cancelled"
      ? await Promise.all([s.store.listSources(id), s.store.listCandidates(id), s.store.listChecks(id), s.store.listJobs(id)])
      : [[], [], [], []];

  return (
    <div className="flex flex-col gap-5">
      {/* Agent runs are driven by the cron only: this page never claims a step for them, it just re-reads every 20 s. */}
      {ai && needsAdvance(run) && !run.agent_id && <RunDriver runId={run.id} status={run.status} />}
      {run.agent_id && run.status === "paused" && (
        <Notice tone="warn">{t.agents.detail.pausedRun}</Notice>
      )}
      {run.agent_id && needsAdvance(run) && run.status !== "paused" && (
        <>
          <AutoRefresh seconds={20} />
          <Notice tone="info">{t.agents.detail.background}</Notice>
        </>
      )}
      {!ai && needsAdvance(run) && !run.agent_id && (
        <Notice tone="warn">{t.ai.notConfigured}</Notice>
      )}

      {showConversation ? (
        <>
          {!talking && (
            <Link href={`/agentes/pesquisa/${run.id}`} className="k-link inline-flex min-h-11 items-center self-start font-mono text-sm text-ink underline decoration-honey decoration-2 underline-offset-4">
              {M.running.backToRun}
            </Link>
          )}
          <Conversation run={run} readOnly={!talking} />
        </>
      ) : searching ? (
        <Progress readOnly={!!run.agent_id} run={run} sources={sources} candidates={candidates} checks={checks} />
      ) : run.status === "done" || candidates.length > 0 ? (
        <>
          {(run.status === "failed" || run.status === "cancelled") && (
            <Notice tone="warn">{run.status === "failed" ? M.failed : M.cancelled}</Notice>
          )}
          <Results run={run} candidates={candidates} checks={checks} jobs={jobs} />
        </>
      ) : (
        <section aria-label={run.title}>
          <EmptyState
            title={run.title}
            action={
              <Link href={`/agentes/pesquisa/${run.id}?view=conversa`} className={buttonClass("secondary")}>
                {M.running.back}
              </Link>
            }
          >
            <p role="status" className="m-0">
              {run.status === "failed" ? `${M.failed} ${run.error ? (t.ai as Record<string, string>)[camel(run.error)] ?? "" : ""}` : M.cancelled}
            </p>
          </EmptyState>
        </section>
      )}
    </div>
  );
}

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}
