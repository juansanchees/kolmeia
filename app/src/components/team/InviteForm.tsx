"use client";

import { useActionState, useState } from "react";
import { createInviteAction } from "@/app/(app)/configuracoes/equipe/actions";
import { btn } from "@/components/email/bits";
import { Field, TextInput } from "@/components/ui";
import { idle, type FormState } from "@/lib/form-state";
import { useT } from "@/lib/i18n/client";

export function InviteForm() {
  const t = useT();
  const [state, action, pending] = useActionState<FormState & { link?: string }, FormData>(createInviteAction, idle);
  // Controlled on purpose: React 19 resets uncontrolled fields after a form action, dropping what was typed on an error.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const link = state.status === "success" ? state.link : undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link ?? "");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4" noValidate>
        <Field label={t.team.name} htmlFor="invite-name">
          <TextInput id="invite-name" name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </Field>
        <Field label={t.team.email} htmlFor="invite-email">
          <TextInput id="invite-email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
        </Field>
        {state.status === "error" && <p role="alert" className="text-sm text-danger">{state.message}</p>}
        <button type="submit" className={btn.primary} disabled={pending}>{t.team.invite}</button>
      </form>
      {link && (
        <div className="flex flex-col gap-2 border border-line p-3" aria-live="polite">
          <label htmlFor="invite-link" className="font-mono text-xs uppercase tracking-wide">{t.team.link}</label>
          <input id="invite-link" readOnly value={link} className="w-full border border-line bg-surface px-3 py-2 text-sm" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={btn.ghost} onClick={copy}>{t.team.copy}{copied ? " ✓" : ""}</button>
          <p className="text-sm">{t.team.sendYourself}</p>
        </div>
      )}
    </div>
  );
}
