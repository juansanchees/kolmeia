"use client";

import { useActionState, useState } from "react";
import { createListAction } from "@/app/(app)/leads/listas/actions";
import { btn } from "@/components/email/bits";
import { idle, type FormState } from "@/lib/form-state";
import { useT } from "@/lib/i18n/client";

export function NewListForm() {
  const t = useT();
  const [state, action, pending] = useActionState<FormState, FormData>(createListAction, idle);
  // Controlled on purpose: React 19 resets uncontrolled fields after a form action.
  const [name, setName] = useState("");
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" noValidate>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wide">{t.lists.newName}</span>
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className="min-h-11 border border-line bg-surface px-3 text-sm text-ink" />
      </label>
      <button type="submit" className={btn.ghost} disabled={pending || !name.trim()}>
        {t.lists.create}
      </button>
      {state.status !== "idle" && (
        <span role={state.status === "error" ? "alert" : "status"} className={`text-sm ${state.status === "error" ? "text-danger" : "text-muted"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
