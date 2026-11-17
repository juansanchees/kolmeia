"use client";

import { useActionState, useState } from "react";
import { addMarkAction } from "@/app/(app)/leads/cobertura/actions";
import { btn } from "@/components/email/bits";
import { Field, TextInput } from "@/components/ui";
import { MA_TOWNS } from "@/lib/coverage/ma-towns";
import { idle, type FormState } from "@/lib/form-state";
import { useT } from "@/lib/i18n/client";

const TOWN_NAMES = [...MA_TOWNS].map((x) => x.name).sort((a, b) => a.localeCompare(b));

// Controlled fields: React 19 resets uncontrolled ones after an action, so an error must not wipe what was typed.
function Fields({ state, pending }: { state: FormState; pending: boolean }) {
  const t = useT();
  const F = t.coverage.form;
  const [town, setTown] = useState("");
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");
  const err = state.fieldErrors ?? {};
  return (
    <>
      <Field label={F.town} htmlFor="mark-town" error={err.town}>
        <TextInput id="mark-town" name="town" list="ma-town-list" value={town} onChange={(e) => setTown(e.target.value)} autoComplete="off" />
        <datalist id="ma-town-list">
          {TOWN_NAMES.map((n) => <option key={n} value={n} />)}
        </datalist>
      </Field>
      <Field label={F.date} htmlFor="mark-date" error={err.date}>
        <TextInput id="mark-date" name="date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Field label={F.note} htmlFor="mark-note" error={err.note}>
        <TextInput id="mark-note" name="note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={btn.primary}>{F.add}</button>
        {state.status === "error" && state.message && <p role="alert" className="text-sm text-danger">{state.message}</p>}
        {state.status === "success" && state.message && <p role="status" className="text-sm text-ok">{state.message}</p>}
      </div>
    </>
  );
}

export function ManualMarkForm() {
  const [saved, setSaved] = useState(0);
  const [state, action, pending] = useActionState(async (_prev: FormState, form: FormData) => {
    const r = await addMarkAction(form);
    if (r.status === "success") setSaved((n) => n + 1);
    return r;
  }, idle);
  return (
    <form action={action} className="flex max-w-md flex-col gap-3" noValidate>
      <Fields key={saved} state={state} pending={pending} />
    </form>
  );
}
