"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveReviewed, decideMessages, saveMessage } from "@/app/(app)/campanhas/actions";
import { bodyProblem, subjectProblem } from "@/lib/email/compose";
import type { MessageStatus, MessageVersion } from "@/lib/email/types";
import { fill, t } from "@/messages/pt";
import { Badge, btn, input, type Tone } from "./bits";
import { Paged } from "@/components/Pager";

const M = t.email;

export const STATUS_TONE: Record<MessageStatus, Tone> = {
  draft: "cold",
  approved: "ok",
  rejected: "warn",
  sending: "soft",
  sent: "ink",
  dry_run: "soft",
  failed: "danger",
  cancelled: "cold",
};

export type EditableMessage = {
  id: string;
  /** The version shown: an approval refers to exactly this text (R1). */
  updatedAt: string;
  /** Where it goes (approved address, or the address it would be approved for). */
  toAddress: string | null;
  kind: "sequence" | "reply";
  step: number | null;
  subject: string;
  body: string;
  status: MessageStatus;
  ai_drafted: boolean;
  human_edited: boolean;
  dueText: string;
  /** Exact final text (body + footer), computed on the server with the same composer that sends. */
  preview: string | null;
  previewProblem: string | null;
};

/** One e-mail: edit subject/body, approve / reject. Editing an approved e-mail drops the approval (R1). */
export function MessageEditor({ m, canSend }: { m: EditableMessage; canSend: boolean }) {
  const router = useRouter();
  const [subject, setSubject] = useState(m.subject);
  const [body, setBody] = useState(m.body);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [pending, start] = useTransition();
  const editable = canSend && (m.status === "draft" || m.status === "approved" || m.status === "rejected");
  const dirty = subject !== m.subject || body !== m.body;
  const problem = subjectProblem(subject, m.kind) ?? bodyProblem(body, m.kind);
  const sid = `subj-${m.id}`;
  const bid = `body-${m.id}`;

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.message || !r.ok ? { ok: r.ok, text: r.message ?? M.genericError } : null);
      router.refresh();
    });

  const title = m.kind === "reply" ? M.replies.yourAnswer : fill(M.review.step, { n: m.step ?? 1 });
  const version: MessageVersion[] = [{ id: m.id, updatedAt: m.updatedAt }];

  return (
    <article className="flex min-w-0 flex-col gap-3 border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 font-display text-xl uppercase">{title}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={m.ai_drafted && !m.human_edited ? "soft" : "cold"}>{m.ai_drafted ? (m.human_edited ? M.humanEdited : M.aiDraft) : m.human_edited ? M.humanEdited : M.template}</Badge>
          <Badge tone={STATUS_TONE[m.status]}>{M.review.statuses[m.status]}</Badge>
          <span className="font-mono text-xs text-muted">{m.dueText}</span>
        </div>
      </div>
      {m.toAddress && <p className="m-0 break-all font-mono text-xs text-muted">{fill(M.review.to, { email: m.toAddress })}</p>}

      <label htmlFor={sid} className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{M.review.subject}</span>
        <input id={sid} className={input} value={subject} maxLength={150} disabled={!editable} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label htmlFor={bid} className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{M.review.body}</span>
        <textarea id={bid} className={`${input} font-body`} rows={8} value={body} maxLength={5000} disabled={!editable} onChange={(e) => setBody(e.target.value)} />
      </label>
      {dirty && problem && (
        <p role="alert" className="text-sm text-danger">
          {M.review.errors[problem]}
        </p>
      )}
      {dirty && m.status === "approved" && <p className="text-[13px] text-warn">{M.review.editClears}</p>}

      {editable && (
        <div className="flex flex-wrap gap-2">
          {dirty && (
            <button type="button" className={btn.primary} disabled={pending || Boolean(problem)} onClick={() => run(() => saveMessage(m.id, subject, body))}>
              {M.review.save}
            </button>
          )}
          {!dirty && m.status !== "approved" && (
            <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => decideMessages(version, "approve"))}>
              {M.review.approve}
            </button>
          )}
          {!dirty && m.status === "approved" && (
            <button type="button" className={btn.ghost} disabled={pending} onClick={() => run(() => decideMessages(version, "unapprove"))}>
              {M.review.unapprove}
            </button>
          )}
          {!dirty && m.status !== "rejected" && (
            <button type="button" className={btn.ghost} disabled={pending} onClick={() => run(() => decideMessages(version, "reject"))}>
              {M.review.reject}
            </button>
          )}
        </div>
      )}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>
          {msg.text}
        </p>
      )}

      <div>
        <button type="button" className={btn.link} aria-expanded={showPreview} onClick={() => setShowPreview((s) => !s)}>
          {M.review.preview}
        </button>
        {showPreview &&
          (m.preview ? (
            <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words border border-line bg-ground p-3 font-mono text-[13px] leading-relaxed">{m.preview}</pre>
          ) : (
            <p className="mt-2 text-sm text-warn">{fill(M.review.previewMissing, { why: m.previewProblem ?? "?" })}</p>
          ))}
      </div>
    </article>
  );
}

/** "Aprovar os 3" for one prospect: the versions on this screen. */
export function ApproveAllButton({ items }: { items: MessageVersion[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!items.length) return null;
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        className={btn.primary}
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await decideMessages(items, "approve");
            setMsg(r.message ? { ok: r.ok, text: r.message } : null);
            router.refresh();
          })
        }
      >
        {M.review.approveAll3}
      </button>
      {msg && (
        <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-warn"}`}>
          {msg.text}
        </span>
      )}
    </span>
  );
}

export type ReviewRow = {
  prospectId: string;
  company: string;
  contact: string;
  messages: { id: string; updatedAt: string; step: number; subject: string; body: string; status: MessageStatus }[];
};

/**
 * List mode. Each company's 3 e-mails are folded; "Revisei" can only be ticked after opening them, and approval
 * sends back exactly the versions that were displayed. Only drafts are approved (the server skips the rest and
 * says how many and why).
 */
export function ReviewList({ rows, campaignId }: { rows: ReviewRow[]; campaignId: string }) {
  const router = useRouter();
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  return (
    <div className="flex flex-col gap-3">
      <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r, i) => {
          const drafts = r.messages.filter((m) => m.status === "draft").length;
          const approved = r.messages.filter((m) => m.status === "approved").length;
          const canTick = opened.has(r.prospectId);
          return (
            <li key={r.prospectId} className="flex min-w-0 flex-col gap-2 border border-line bg-surface p-3">
              <div className="flex min-w-0 flex-wrap items-start gap-3">
                <input
                  id={`rv-${r.prospectId}`}
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0 disabled:opacity-40"
                  disabled={!canTick}
                  aria-describedby={canTick ? undefined : `rv-hint-${r.prospectId}`}
                  aria-label={`${M.review.reviewed}: ${r.company}`}
                  checked={checked.has(r.prospectId)}
                  onChange={(e) => setChecked(toggle(checked, r.prospectId, e.target.checked))}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{r.company}</span>
                  <span className="break-all text-[13px] text-muted">{r.contact}</span>
                  <span className="font-mono text-xs text-muted">
                    {approved}/{drafts + approved} {M.review.statuses.approved}
                  </span>
                </div>
                <a href={`/campanhas/${campaignId}/revisar?i=${i}`} className={btn.link}>
                  {M.review.oneByOne}
                </a>
              </div>
              {!canTick && (
                <p id={`rv-hint-${r.prospectId}`} className="m-0 text-[13px] text-muted">
                  {M.review.readAllFirst}
                </p>
              )}
              <details onToggle={(e) => (e.currentTarget.open ? setOpened(toggle(opened, r.prospectId, true)) : undefined)}>
                <summary className="cursor-pointer text-sm text-blue underline underline-offset-4">{M.review.showBodies}</summary>
                <div className="mt-2 flex flex-col gap-3">
                  {r.messages.map((m) => (
                    <div key={m.id} className="flex min-w-0 flex-col gap-1 border-l-2 border-line pl-3">
                      <span className="font-mono text-xs text-muted">
                        {fill(M.review.step, { n: m.step })} · {M.review.statuses[m.status]}
                      </span>
                      <span className="break-words text-sm font-semibold">{m.subject}</span>
                      <p className="m-0 whitespace-pre-wrap break-words text-sm">{m.body}</p>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </Paged>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btn.primary}
          disabled={pending || checked.size === 0}
          onClick={() =>
            start(async () => {
              const items = rows.filter((r) => checked.has(r.prospectId)).flatMap((r) => r.messages.map((m) => ({ id: m.id, updatedAt: m.updatedAt })));
              const r = await approveReviewed(items);
              setMsg({ ok: r.ok, text: r.message ?? (r.ok ? "" : M.genericError) });
              setChecked(new Set());
              router.refresh();
            })
          }
        >
          {M.review.approveReviewed} ({checked.size})
        </button>
        {msg?.text && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-warn"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
