"use client";

import { useActionState } from "react";
import { createResearch } from "@/app/(app)/agentes/actions";
import { idle } from "@/lib/form-state";
import { Button, Field, TextArea, TextInput } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

export function NewResearchForm() {
  const t = useT();
  const M = t.research.newForm;
  const [state, action, pending] = useActionState(createResearch, idle);
  const err = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <Field label={M.request} htmlFor="request" error={err.request}>
        <TextArea
          id="request"
          name="request"
          rows={3}
          maxLength={2000}
          required
          placeholder={M.requestPlaceholder}
          aria-invalid={Boolean(err.request)}
          aria-describedby={err.request ? "request-error" : undefined}
        />
      </Field>
      <Field label={M.region} htmlFor="region" hint={M.regionHint} error={err.region}>
        <TextInput
          id="region"
          name="region"
          maxLength={1000}
          required
          placeholder={M.regionPlaceholder}
          aria-invalid={Boolean(err.region)}
          aria-describedby={err.region ? "region-error region-hint" : "region-hint"}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {M.submit}
        </Button>
        {state.status === "error" && state.message && (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
