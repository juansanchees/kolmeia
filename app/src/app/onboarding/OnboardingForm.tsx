"use client";

import { useActionState } from "react";
import { createWorkspace } from "./actions";
import { idle } from "@/lib/form-state";
import { Button, Field, Notice, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

export function OnboardingForm() {
  const t = useT();
  const [state, action, pending] = useActionState(createWorkspace, idle);
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-4xl">{t.onboarding.title}</h1>
        <p className="m-0 text-lg text-[#4a5361]">{t.onboarding.intro}</p>
      </div>
      <Field label={t.onboarding.name} htmlFor="name" error={state.fieldErrors?.name}>
        <TextInput id="name" name="name" maxLength={80} required aria-invalid={Boolean(state.fieldErrors?.name)} aria-describedby={state.fieldErrors?.name ? "name-error" : undefined} className="min-h-14! text-[17px]!" />
      </Field>
      {state.status === "error" && state.message && <Notice tone="danger" role="alert">{state.message}</Notice>}
      <Button type="submit" disabled={pending} className="min-h-14! text-[17px]!">{t.onboarding.submit}</Button>
    </form>
  );
}
