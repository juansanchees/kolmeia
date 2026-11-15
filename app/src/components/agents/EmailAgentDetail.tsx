"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveSequenceAction, rewriteSequenceAction, saveSequenceEditAction, setEmailAgentRunningAction, type EmailActionResult } from "@/app/(app)/agentes/[id]/email-actions";
import { btn, Notice } from "@/components/email/bits";
import { Pill } from "@/components/research/controls";
import { stepProblems } from "@/lib/email/template";
import type { AgentRow } from "@/lib/agents/types";
import type { SequenceRow } from "@/lib/email-agent/queries";
import type { EmailAgentMetrics, SequencePreview } from "@/lib/email-agent/types";
import type { SenderProfile } from "@/lib/email/types";
import { fill, t } from "@/messages/pt";
import { ArchiveButton } from "./ArchiveButton";
import { parseDelays, SequenceEditor, type EditorValue } from "./SequenceEditor";
import { SequenceExamples } from "./SequenceExamples";

const A = t.agents;
const D = t.emailAgent.detail;

export type EmailAgentDetailProps = {
  agent: AgentRow;
  campaignId: string;
  sequence: SequenceRow | null;
  preview: SequencePreview | null;
  metrics: EmailAgentMetrics;
  sender: SenderProfile | null;
  c12Ready: boolean;
  isOwner: boolean;
  /** Upper bound of the one AI call (its reservation), shown before the click. */
  estimateUsd: number;
};

function initial(s: SequenceRow | null): EditorValue {
  return { steps: s?.steps ?? [], tone: s?.tone ?? "direct", step2: String(s?.step2_delay_days ?? 3), step3: String(s?.step3_delay_days ?? 7) };
}

/** The agent page: a new version of the text resets approval, so the editor, the 3 examples and Approve live together. */
export function EmailAgentDetail(props: EmailAgentDetailProps) {
  // a new saved version remounts the editor with its text; an approval of the same version only refreshes the pill
  return <Inner key={props.sequence?.id ?? "none"} {...props} />;
}

function Inner({ agent, campaignId, sequence, preview, metrics, sender, c12Ready, isOwner, estimateUsd }: EmailAgentDetailProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [value, setValue] = useState<EditorValue>(() => initial(sequence));

  const running = agent.status === "running";
  const approved = sequence?.status === "approved";
  const base = initial(sequence);
  const dirty = JSON.stringify(value) !== JSON.stringify(base);
  const delays = parseDelays(value);
  const valid = value.steps.length > 0 && value.steps.every((s) => stepProblems(s).length === 0) && (value.steps.length === 1 || delays !== null);
  const examples = preview?.examples ?? [];

  const run = (job: () => Promise<EmailActionResult>) =>
    start(async () => {
      setMsg(null);
      const r = await job();
      if (r.message) setMsg({ tone: r.status === "ok" ? "ok" : "warn", text: r.message });
      else if (r.status === "error") setMsg({ tone: "warn", text: D.failed });
      router.refresh();
    });

  const save = () => run(() => saveSequenceEditAction(campaignId, value.steps, value.tone, delays ?? { step2: Number(base.step2), step3: Number(base.step3) }));
  // the digest of the examples this screen is showing: nothing else is ever sent for approval
  const approve = () => preview && sequence && run(() => approveSequenceAction(sequence.id, preview.digest));

  const m = metrics;
  return (
    <section aria-labelledby="agent-title" className="flex flex-col gap-5 border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
        <h2 id="agent-title" className="text-2xl">
          {agent.name}
        </h2>
        <span className="flex items-center gap-2 font-mono text-xs text-muted">
          {A.types.email} · <span className="border border-line px-2 py-0.5">{A.statuses[agent.status]}</span>
          <Pill tone={approved ? "ok" : "unknown"}>{approved ? D.status.approved : D.status.waiting}</Pill>
        </span>
      </div>

      {!c12Ready && (
        <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm font-semibold text-warn">
          {D.rehearsalOnly}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || (!running && !approved)}
          className={running ? btn.ghost : btn.primary}
          onClick={() => run(() => setEmailAgentRunningAction(agent.id, !running))}
        >
          {running ? D.pause : D.turnOn}
        </button>
        {!running && !approved && <span className="text-sm text-muted">{D.turnOnNeeds}</span>}
        {!running && <ArchiveButton agentId={agent.id} />}
      </div>

      {msg && (
        <Notice tone={msg.tone} role={msg.tone === "warn" ? "alert" : "status"}>
          {msg.text}
        </Notice>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">{D.sequence}</h3>
          {sequence && (
            <span className="font-mono text-xs text-muted">
              {fill(D.version, { n: sequence.version })}
              {sequence.human_edited ? ` · ${D.humanEdited}` : ""}
            </span>
          )}
        </div>
        {sequence ? (
          <SequenceEditor value={value} onChange={setValue} disabled={pending} />
        ) : (
          <p className="text-sm text-muted">{D.noSequence}</p>
        )}
        <p className="text-sm text-muted">{D.editResets}</p>
        <div className="flex flex-wrap items-center gap-3">
          {sequence && (
            <button type="button" className={btn.primary} disabled={pending || !dirty || !valid} onClick={save}>
              {pending ? D.saving : D.save}
            </button>
          )}
          <button type="button" className={btn.ghost} disabled={pending} onClick={() => run(() => rewriteSequenceAction(campaignId))}>
            {pending ? D.rewriting : D.rewrite}
          </button>
        </div>
        <p className="text-sm text-muted">{fill(D.rewriteEstimate, { usd: estimateUsd.toFixed(2) })}</p>
      </div>

      {sequence && (
        <>
          <SequenceExamples examples={examples} sender={sender} rehearsalOnly={!c12Ready} />
          {isOwner ? (
            <div className="flex flex-col items-start gap-2">
              <button type="button" className={btn.primary} disabled={pending || approved || dirty || examples.length === 0 || !preview} onClick={approve}>
                {pending ? D.approving : D.approve}
              </button>
              {approved && <p className="text-sm text-muted">{D.alreadyApproved}</p>}
              {dirty && !approved && <p className="text-sm text-muted">{D.unsavedBlocksApprove}</p>}
              {!dirty && !approved && examples.length === 0 && <p className="text-sm text-muted">{D.needsExamples}</p>}
            </div>
          ) : (
            <p className="text-sm text-muted">{D.onlyOwner}</p>
          )}
        </>
      )}

      <dl className="m-0" aria-label={D.metrics.title}>
        {(["drafts", "approved", "sent", "replies", "unsubscribed", "bounced"] as const).map((k) => (
          <div key={k} className="grid grid-cols-1 gap-x-4 border-t border-line py-2 text-sm sm:grid-cols-[14rem_1fr]">
            <dt className="font-mono text-xs text-muted">{D.metrics[k]}</dt>
            <dd className="m-0">{m[k]}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-1">
        <Link href={`/campanhas/${campaignId}`} className={btn.link}>
          {D.campaign}
        </Link>
        <span className="text-sm text-muted">{D.campaignHint}</span>
      </div>
    </section>
  );
}
