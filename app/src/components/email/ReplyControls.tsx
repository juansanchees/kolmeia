"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { fetchRepliesAction, setReplyLabel } from "@/app/(app)/campanhas/actions";
import { REPLY_CLASSES, type ReplyClass } from "@/lib/email/types";
import { fill, t } from "@/messages/pt";
import { btn, input } from "./bits";
import { outcomeTime, timeOf } from "./format";

const M = t.email.replies;
const S = t.email.send;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Buscar respostas": reads the mailbox on demand (no background worker). */
export function FetchRepliesButton({ mailboxes }: { mailboxes: { id: string; email: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!mailboxes.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          className={btn.primary}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const texts: string[] = [];
              let allOk = true;
              for (const m of mailboxes) {
                const r = await fetchRepliesAction(m.id);
                allOk &&= r.ok;
                texts.push(mailboxes.length > 1 ? `${m.email}: ${r.message ?? ""}` : (r.message ?? ""));
              }
              setMsg({ ok: allOk, text: texts.join(" · ") });
              router.refresh();
            })
          }
        >
          {pending ? M.fetching : M.fetch}
        </button>
      </div>
      <p className="text-[13px] text-muted">{M.fetchHint}</p>
      {msg?.text && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** A person can correct the AI label. "Pediu para sair" suppresses the address (the safe direction). */
export function ReplyLabelSelect({ replyId, value, disabled }: { replyId: string; value: ReplyClass | null; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const id = `label-${replyId}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="font-mono text-xs text-muted">{M.label}</span>
      <select
        id={id}
        className={`${input} max-w-56 py-1.5 text-sm`}
        value={value ?? ""}
        disabled={disabled || pending}
        onChange={(e) =>
          start(async () => {
            await setReplyLabel(replyId, e.target.value);
            router.refresh();
          })
        }
      >
        <option value="" disabled>
          ?
        </option>
        {REPLY_CLASSES.map((c) => (
          <option key={c} value={c}>
            {M.labels[c]}
          </option>
        ))}
      </select>
    </label>
  );
}

type SendReply = { outcome?: string; waitUntil?: string; error?: string; stop?: boolean };

/**
 * "Enviar resposta": sends this one approved answer now (any campaign state), under the mailbox limits. If the
 * mailbox is inside its gap (9 + 5 min), it waits on the screen and tries again (while the page stays open).
 */
export function ReplySendButton({ messageId, timezone }: { messageId: string; timezone?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    for (let attempt = 0; attempt < 5; attempt++) {
      let r: SendReply;
      try {
        const res = await fetch(`/api/email/replies/${messageId}/send`, { method: "POST" });
        r = (await res.json()) as SendReply;
      } catch {
        setMsg({ ok: false, text: t.email.genericError });
        break;
      }
      const outcome = (r.outcome ?? "not_found") as keyof typeof S.outcomes;
      if (outcome === "gap" && r.waitUntil) {
        setMsg({ ok: true, text: fill(S.waitGap, { time: timeOf(r.waitUntil) }) });
        await sleep(Math.max(1_000, new Date(r.waitUntil).getTime() - Date.now() + 1_500));
        continue;
      }
      const text = r.stop ? fill(S.mailboxStop, { error: r.error ?? "?" }) : fill(S.outcomes[outcome] ?? t.email.genericError, { time: outcomeTime(outcome, r.waitUntil, timezone), error: r.error ?? "?" });
      setMsg({ ok: outcome === "sent" || outcome === "dry_run", text });
      break;
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" className={btn.primary} disabled={busy} onClick={run}>
        {busy ? M.sendingAnswer : M.sendAnswer}
      </button>
      {msg && (
        <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-warn"}`}>
          {msg.text}
        </span>
      )}
    </span>
  );
}
