"use client";

import { useActionState } from "react";
import { createWorkspace } from "./actions";
import { idle } from "@/lib/form-state";
import { Button, Field, TextInput } from "@/components/ui";
import { t } from "@/messages/pt";

export function OnboardingForm() {
  const [state, action, pending] = useActionState(createWorkspace, idle);
  return (
    <form action={action} className="flex flex-col gap-5 border border-line bg-surface p-6" noValidate>
      <h1 className="text-3xl">{t.onboarding.title}</h1>
      <p className="text-sm">{t.onboarding.intro}</p>
      <Field label={t.onboarding.name} htmlFor="name" error={state.fieldErrors?.name}>
        <TextInput id="name" name="name" maxLength={80} required aria-invalid={Boolean(state.fieldErrors?.name)} aria-describedby={state.fieldErrors?.name ? "name-error" : undefined} />
      </Field>
      {state.status === "error" && state.message && <p role="alert" className="text-sm text-danger">{state.message}</p>}
      <Button type="submit" disabled={pending}>{t.onboarding.submit}</Button>
    </form>
  );
}
