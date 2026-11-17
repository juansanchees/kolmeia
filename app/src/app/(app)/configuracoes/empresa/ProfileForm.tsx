"use client";

import { useActionState, useState } from "react";
import { saveProfile } from "./actions";
import { idle } from "@/lib/form-state";
import { WANTED_WORK, type ProfileInput } from "@/lib/profile-schema";
import { Button, Field, HexPanel, TextArea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

export function ProfileForm({ initial, readOnly }: { initial: ProfileInput; readOnly: boolean }) {
  const t = useT();
  const [state, action, pending] = useActionState(saveProfile, idle);
  // Controlled on purpose: React resets uncontrolled fields after a form action, which would drop the saved values.
  const [v, setV] = useState(initial);
  const set = <K extends keyof ProfileInput>(k: K, val: ProfileInput[K]) => setV((cur) => ({ ...cur, [k]: val }));
  const err = state.fieldErrors ?? {};
  const describe = (id: string) => (err[id] ? `${id}-error` : undefined);

  return (
    <HexPanel as="div" className="py-7" wrapClassName="k-in">
    <form action={action} className="flex flex-col gap-6" noValidate>
      <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
      <Field label={t.company.whatWeDo} htmlFor="what_we_do" error={err.what_we_do}>
        <TextArea id="what_we_do" name="what_we_do" value={v.what_we_do} onChange={(e) => set("what_we_do", e.target.value)} maxLength={2000} required aria-invalid={Boolean(err.what_we_do)} aria-describedby={describe("what_we_do")} />
      </Field>
      <Field label={t.company.serviceArea} htmlFor="service_area" error={err.service_area}>
        <TextArea id="service_area" name="service_area" rows={2} value={v.service_area} onChange={(e) => set("service_area", e.target.value)} maxLength={2000} required aria-invalid={Boolean(err.service_area)} aria-describedby={describe("service_area")} />
      </Field>

      <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={describe("wanted_work")}>
        <legend className="mb-2 font-mono text-[13px] font-medium uppercase tracking-wide">{t.company.wantedWork}</legend>
        <div className="flex flex-wrap gap-2">
          {WANTED_WORK.map((key) => (
            <label key={key} className="relative cursor-pointer">
              <input
                type="checkbox"
                name="wanted_work"
                value={key}
                checked={v.wanted_work.includes(key)}
                onChange={(e) => set("wanted_work", e.target.checked ? [...v.wanted_work, key] : v.wanted_work.filter((w) => w !== key))}
                className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
              <span className="k-btn flex min-h-11 items-center rounded-full border-2 border-line bg-surface px-4 text-base hover:border-ink peer-checked:border-honey-edge peer-checked:bg-honey-light peer-checked:font-semibold peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink">
                {t.wantedWorkOptions[key]}
              </span>
            </label>
          ))}
        </div>
        {err.wanted_work && <p id="wanted_work-error" role="alert" className="mt-1.5 text-sm text-danger">{err.wanted_work}</p>}
      </fieldset>

      <Field label={t.company.goodCustomer} htmlFor="good_customer" error={err.good_customer}>
        <TextArea id="good_customer" name="good_customer" value={v.good_customer} onChange={(e) => set("good_customer", e.target.value)} maxLength={2000} aria-invalid={Boolean(err.good_customer)} aria-describedby={describe("good_customer")} />
      </Field>
      <Field label={t.company.notWanted} htmlFor="not_wanted" error={err.not_wanted}>
        <TextArea id="not_wanted" name="not_wanted" value={v.not_wanted} onChange={(e) => set("not_wanted", e.target.value)} maxLength={2000} aria-invalid={Boolean(err.not_wanted)} aria-describedby={describe("not_wanted")} />
      </Field>

      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        {!readOnly && <Button type="submit" disabled={pending}>{pending ? t.company.saving : t.company.save}</Button>}
        <div aria-live="polite">
          {state.status === "success" && <p className="font-mono text-sm text-ok">{state.message}</p>}
          {state.status === "error" && state.message && <p role="alert" className="text-sm text-danger">{state.message}</p>}
        </div>
      </div>
    </form>
    </HexPanel>
  );
}
