"use client";

import { useActionState, useState } from "react";
import { createListAction } from "@/app/(app)/leads/listas/actions";
import { Button, TextInput } from "@/components/ui";
import { idle, type FormState } from "@/lib/form-state";
import { useT } from "@/lib/i18n/client";

export function NewListForm() {
  const t = useT();
  const [state, action, pending] = useActionState<FormState, FormData>(createListAction, idle);
  // Controlled on purpose: React 19 resets uncontrolled fields after a form action.
  const [name, setName] = useState("");
  return (
    <form action={action} className="k-in flex flex-wrap items-end gap-3 rounded-2xl border-2 border-dashed border-line bg-surface p-4 [animation-delay:.15s]" noValidate>
      <label className="flex min-w-0 flex-[1_1_260px] flex-col gap-1.5">
        <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{t.lists.newName}</span>
        <TextInput name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
      </label>
      <Button type="submit" variant="secondary" disabled={pending || !name.trim()}>
        <span aria-hidden>+</span> {t.lists.create}
      </Button>
      {state.status !== "idle" && (
        <span role={state.status === "error" ? "alert" : "status"} className={`w-full text-base ${state.status === "error" ? "text-danger" : "text-ok"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
