"use client";

import { useActionState, useState } from "react";
import { createInviteAction } from "@/app/(app)/configuracoes/equipe/actions";
import { Button, Field, HexButton, TextInput } from "@/components/ui";
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
        <div><HexButton type="submit" disabled={pending}>{t.team.invite}</HexButton></div>
      </form>
      {link && (
        <div className="flex flex-col gap-2 rounded-[14px] border-2 border-honey-edge bg-honey-soft p-4" aria-live="polite">
          <label htmlFor="invite-link" className="font-mono text-[13px] font-medium uppercase tracking-wide">{t.team.link}</label>
          <TextInput id="invite-link" readOnly value={link} className="text-sm" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="secondary" size="sm" onClick={copy}>{t.team.copy}{copied ? " ✓" : ""}</Button>
          <p className="text-sm">{t.team.sendYourself}</p>
        </div>
      )}
    </div>
  );
}
