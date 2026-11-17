import type { RunRow } from "@/lib/research/rows";
import { getT } from "@/lib/i18n/server";
import { PlanCard } from "./PlanCard";
import { QuestionsForm } from "./QuestionsForm";

function UserBubble({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[80%] self-end bg-blue px-3.5 py-3 text-[15px] leading-normal text-white">{children}</div>;
}

function AiBubble({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="flex max-w-full flex-col gap-3.5 self-start border border-[#c9d8f7] bg-blue-wash p-4 sm:max-w-[92%]">
      {label && <span className="font-mono text-[11px] uppercase text-blue-ink">{label}</span>}
      {children}
    </div>
  );
}

/** Prototype "Pedido": the request, the AI's questions, the plan to approve. */
export async function Conversation({ run, readOnly }: { run: RunRow; readOnly: boolean }) {
  const t = await getT();
  const M = t.research;
  const questions = run.questions ?? [];
  const answered = run.status !== "questions";
  return (
    <section aria-label={M.conversation.label} className="flex flex-col border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 border-b border-ink px-5 py-3.5">
        <h2 className="text-2xl">{run.title}</h2>
        <span className="font-mono text-xs text-muted">{M.status[run.status]}</span>
      </div>

      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <UserBubble>
          {run.request_text}
          <span className="mt-1 block text-[13px] opacity-90">{run.region_text}</span>
        </UserBubble>

        {run.questions === null && <p className="font-mono text-xs text-muted">{M.conversation.thinking}</p>}

        {run.questions !== null && (
          <AiBubble label={t.ai.suggestion}>
            <p className="text-[15px] leading-normal">
              <span className="font-semibold">{M.conversation.understood}</span> {run.progress.understood ?? ""}{" "}
              {questions.length ? M.conversation.askIntro : M.conversation.noQuestions}
            </p>
            {questions.length > 0 && (
              <QuestionsForm
                runId={run.id}
                questions={questions}
                answers={run.answers}
                region={run.region_text}
                places={run.progress.places ?? []}
                disabled={readOnly || answered}
              />
            )}
          </AiBubble>
        )}

        {run.adjustments.map((a, i) => (
          <UserBubble key={i}>{a}</UserBubble>
        ))}

        {run.status === "plan" && run.plan === null && <p className="font-mono text-xs text-muted">{M.conversation.planning}</p>}

        {run.plan && <PlanCard run={run} readOnly={readOnly || run.status !== "plan"} />}
      </div>
    </section>
  );
}
