"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { handOffLeadAction } from "@/app/(app)/leads/lead-actions";
import { btn } from "@/components/email/bits";
import { Field, TextArea, TextInput } from "@/components/ui";
import type { BriefDraft } from "@/lib/leads/brief";
import type { Person } from "@/lib/team/types";
import { fill, t } from "@/messages/pt";

const H = t.handoff;

/** "Passar pra closer": the draft is editable, the proof links are shown as they are. Values stay after an error. */
export function HandOffForm({ leadId, closers, draft }: { leadId: string; closers: Person[]; draft: BriefDraft }) {
  const router = useRouter();
  const list = closers.filter((p) => p.role === "closer");
  const [closerId, setCloserId] = useState(list[0]?.user_id ?? "");
  const [who, setWho] = useState(draft.who);
  const [said, setSaid] = useState(draft.what_they_said);
  const [next, setNext] = useState(draft.next_step);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (list.length === 0) {
    return (
      <p className="text-sm text-muted">
        {H.noCloser}{" "}
        <Link href="/configuracoes/equipe" className="text-blue underline underline-offset-4">
          {t.team.tab}
        </Link>
      </p>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await handOffLeadAction(leadId, closerId, { who, what_they_said: said, next_step: next, evidence_urls: draft.evidence_urls });
      if (r.status === "success") {
        const name = list.find((p) => p.user_id === closerId)?.label ?? "";
        setMsg({ ok: true, text: fill(H.done, { name }) });
        router.refresh();
      } else {
        setMsg({ ok: false, text: r.message ?? H.failed });
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label={H.to} htmlFor="ho-to">
        <select id="ho-to" value={closerId} onChange={(e) => setCloserId(e.target.value)} className="min-h-11 w-full border border-line bg-surface px-2.5 text-base text-ink">
          {list.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={H.who} htmlFor="ho-who">
        <TextInput id="ho-who" value={who} maxLength={600} onChange={(e) => setWho(e.target.value)} />
      </Field>
      <Field label={H.said} htmlFor="ho-said">
        <TextArea id="ho-said" value={said} maxLength={800} onChange={(e) => setSaid(e.target.value)} />
      </Field>
      <Field label={H.next} htmlFor="ho-next">
        <TextInput id="ho-next" value={next} maxLength={400} required onChange={(e) => setNext(e.target.value)} />
      </Field>
      {draft.evidence_urls.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs uppercase tracking-wide">{H.proof}</span>
          {draft.evidence_urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[13px] text-blue underline underline-offset-4">
              {u} ↗
            </a>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={btn.cta} disabled={pending}>
          {H.button}
        </button>
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-ok" : "text-danger"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
