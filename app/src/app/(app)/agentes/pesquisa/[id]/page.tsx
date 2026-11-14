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
import { t } from "@/messages/pt";

// The step route runs up to 300 s; server actions on this page are short, but keep the same ceiling.
export const maxDuration = 300;

const M = t.research;

export default async function ResearchRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
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
      {run.agent_id && needsAdvance(run) && (
        <>
          <AutoRefresh seconds={20} />
          <p role="status" className="bg-blue-wash px-3 py-2.5 text-sm text-blue-ink">
            {t.agents.detail.background}
          </p>
        </>
      )}
      {!ai && needsAdvance(run) && !run.agent_id && (
        <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {t.ai.notConfigured}
        </p>
      )}

      {showConversation ? (
        <>
          {!talking && (
            <Link href={`/agentes/pesquisa/${run.id}`} className="font-mono text-xs text-blue underline underline-offset-4">
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
            <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
              {run.status === "failed" ? M.failed : M.cancelled}
            </p>
          )}
          <Results run={run} candidates={candidates} checks={checks} jobs={jobs} />
        </>
      ) : (
        <section className="border border-line bg-surface p-5">
          <h2 className="text-2xl">{run.title}</h2>
          <p role="status" className="mt-3 text-sm">
            {run.status === "failed" ? `${M.failed} ${run.error ? (t.ai as Record<string, string>)[camel(run.error)] ?? "" : ""}` : M.cancelled}
          </p>
          <Link href={`/agentes/pesquisa/${run.id}?view=conversa`} className="mt-3 inline-block text-sm text-blue underline underline-offset-4">
            {M.running.back}
          </Link>
        </section>
      )}
    </div>
  );
}

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}
