import type { RunRow } from "@/lib/research/rows";
import { getT } from "@/lib/i18n/server";
import { PlanCard } from "./PlanCard";
import { QuestionsForm } from "./QuestionsForm";
import { AiBubble, UserBubble } from "./controls";
import { Badge, HexPanel } from "@/components/ui";

/** Prototype "Pedido": the request, the AI's questions, the plan to approve. */
export async function Conversation({ run, readOnly }: { run: RunRow; readOnly: boolean }) {
  const t = await getT();
  const M = t.research;
  const questions = run.questions ?? [];
  const answered = run.status !== "questions";
  return (
    <HexPanel as="section" aria-label={M.conversation.label} raised wrapClassName="k-in" className="flex flex-col gap-5 py-7">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-[#e3e6ec] pb-4">
        <h2 className="text-3xl">{run.title}</h2>
        <Badge tone="honey">{M.status[run.status]}</Badge>
      </div>

      <div className="flex flex-col gap-4">
        <UserBubble>
          {run.request_text}
          <span className="mt-1 block text-[15px] text-honey-glow">{run.region_text}</span>
        </UserBubble>

        {run.questions === null && <p className="m-0 font-mono text-sm text-[#4a5361]">{M.conversation.thinking}</p>}

        {run.questions !== null && (
          <AiBubble label={t.ai.suggestion}>
            <p className="m-0 text-base leading-normal">
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

        {run.status === "plan" && run.plan === null && <p className="m-0 font-mono text-sm text-[#4a5361]">{M.conversation.planning}</p>}

        {run.plan && <PlanCard run={run} readOnly={readOnly || run.status !== "plan"} />}
      </div>
    </HexPanel>
  );
}
