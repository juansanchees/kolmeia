"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveSequenceAction, rewriteSequenceAction, saveSequenceEditAction, setEmailAgentRunningAction, type EmailActionResult } from "@/app/(app)/agentes/[id]/email-actions";
import { Badge, buttonClass, HexPanel, Notice, StepTitle } from "@/components/ui";
import { powerClass } from "@/components/research/controls";
import { AgentHead, DlStat } from "./AgentHead";
import { approveBlock } from "@/lib/email-agent/gating";
import { stepProblems } from "@/lib/email/template";
import type { AgentRow } from "@/lib/agents/types";
import type { SequenceRow } from "@/lib/email-agent/queries";
import type { EmailAgentMetrics, SequencePreview } from "@/lib/email-agent/types";
import type { SenderProfile } from "@/lib/email/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { ArchiveButton } from "./ArchiveButton";
import { parseDelays, SequenceEditor, type EditorValue } from "./SequenceEditor";
import { SequenceExamples } from "./SequenceExamples";

export type EmailAgentDetailProps = {
  agent: AgentRow;
  campaignId: string;
  sequence: SequenceRow | null;
  preview: SequencePreview | null;
  metrics: EmailAgentMetrics;
  sender: SenderProfile | null;
  c12Ready: boolean;
  /** The campaign's mode: rehearsal (dry_run) or real. */
  sendMode: "dry_run" | "real";
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

function Inner({ agent, campaignId, sequence, preview, metrics, sender, c12Ready, sendMode, isOwner, estimateUsd }: EmailAgentDetailProps) {
  const t = useT();
  const A = t.agents;
  const D = t.emailAgent.detail;
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
  const block = approveBlock({ approved, dirty, hasPreview: Boolean(preview), examples: examples.length, hasSender: Boolean(sender?.sender_name.trim() && sender.postal_address.trim()) });

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
  const muted = "m-0 text-base text-[#4a5361]";
  return (
    <HexPanel as="section" aria-labelledby="agent-title" raised wrapClassName="k-in" className="flex flex-col gap-7 py-7">
      <div className="flex flex-col gap-2">
        <AgentHead id="agent-title" name={agent.name} type="email" typeLabel={A.types.email} status={agent.status} statusLabel={A.statuses[agent.status]}>
          <Badge tone={approved ? "ok" : "neutral"}>{approved ? D.status.approved : D.status.waiting}</Badge>
        </AgentHead>
        <p className="m-0 font-mono text-sm text-[#4a5361]" data-send-mode={sendMode}>
          {sendMode === "real" ? D.modeReal : D.modeDry}
        </p>
      </div>

      {!c12Ready && (
        <Notice tone="warn" className="font-semibold">
          {D.rehearsalOnly}
        </Notice>
      )}

      <div className="flex flex-col gap-3">
        <StepTitle n={1} as="h3" hint={!running && !approved ? D.turnOnNeeds : undefined}>
          {A.detail.steps.power}
        </StepTitle>
        <div className="flex flex-col gap-3 md:pl-[42px]">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending || (!running && !approved)}
              className={powerClass(running)}
              onClick={() => run(() => setEmailAgentRunningAction(agent.id, !running))}
            >
              {running ? D.pause : D.turnOn}
            </button>
            {!running && <ArchiveButton agentId={agent.id} />}
          </div>
          {msg && (
            <Notice tone={msg.tone} role={msg.tone === "warn" ? "alert" : "status"}>
              {msg.text}
            </Notice>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StepTitle n={2} as="h3" hint={D.editResets}>
            {D.sequence}
          </StepTitle>
          {sequence && (
            <span className="font-mono text-sm text-[#4a5361]">
              {fill(D.version, { n: sequence.version })}
              {sequence.human_edited ? ` · ${D.humanEdited}` : ""}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-3 md:pl-[42px]">
          {sequence ? <SequenceEditor value={value} onChange={setValue} disabled={pending} /> : <p className={muted}>{D.noSequence}</p>}
          <div className="flex flex-wrap items-center gap-3">
            {sequence && (
              <button type="button" className={buttonClass("primary")} disabled={pending || !dirty || !valid} onClick={save}>
                {pending ? D.saving : D.save}
              </button>
            )}
            <button type="button" className={buttonClass("secondary")} disabled={pending} onClick={() => {
              // an approved version is replaced: unsent mail of that text is cancelled and the owner approves again
              if (approved && !window.confirm(D.rewriteConfirm)) return;
              run(() => rewriteSequenceAction(campaignId));
            }}>
              {pending ? D.rewriting : D.rewrite}
            </button>
          </div>
          <p className={muted}>{fill(D.rewriteEstimate, { usd: estimateUsd.toFixed(2) })}</p>
        </div>
      </div>

      {sequence && (
        <div className="flex flex-col gap-3">
          <StepTitle n={3} as="h3">{D.examples}</StepTitle>
          <div className="flex flex-col gap-4 md:pl-[42px]">
            <SequenceExamples examples={examples} sender={sender} rehearsalOnly={!c12Ready} />
            {isOwner ? (
              <div className="flex flex-col items-start gap-2">
                <button type="button" className={buttonClass("primary")} disabled={pending || block !== null} onClick={approve}>
                  {pending ? D.approving : D.approve}
                </button>
                {approved && <p className={muted}>{D.alreadyApproved}</p>}
                {block === "dirty" && <p className={muted}>{D.unsavedBlocksApprove}</p>}
                {block === "examples" && <p className={muted}>{D.needsExamples}</p>}
                {block === "sender" && <p className={muted}>{D.needsSender}</p>}
              </div>
            ) : (
              <p className={muted}>{D.onlyOwner}</p>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <StepTitle n={sequence ? 4 : 3} as="h3">{D.metrics.title}</StepTitle>
        <dl className="m-0 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))] md:pl-[42px]" aria-label={D.metrics.title}>
          {(["drafts", "approved", "sent", "replies", "unsubscribed", "bounced"] as const).map((k) => (
            <DlStat key={k} label={D.metrics[k]} value={m[k]} />
          ))}
        </dl>
      </div>

      <div className="flex flex-col gap-1">
        <Link href={`/campanhas/${campaignId}`} className="k-link inline-flex min-h-11 items-center self-start text-base font-semibold text-ink underline decoration-honey decoration-2 underline-offset-4">
          {D.campaign}
        </Link>
        <span className={muted}>{D.campaignHint}</span>
      </div>
    </HexPanel>
  );
}
