"use client";

import { useActionState, useState } from "react";
import { idle } from "@/lib/form-state";
import { useT } from "@/lib/i18n/client";
import { joinWaitlist } from "./actions";

export function WaitlistForm() {
  const t = useT().landing.waitlist;
  const [state, action, pending] = useActionState(joinWaitlist, idle);
  // Controlled so a failed try keeps what the person typed (React resets uncontrolled fields after a form action).
  const [email, setEmail] = useState("");
  return (
    <form className="wl-form" action={action} noValidate>
      <label htmlFor="wl-email">{t.label}</label>
      <div className="wl-row">
        <input id="wl-email" name="email" type="email" autoComplete="email" placeholder={t.placeholder} required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={state.status === "error"} aria-describedby="wl-msg" />
        <button className="btn btn-honey" type="submit" disabled={pending}>
          {pending ? t.sending : t.submit}
        </button>
      </div>
      {/* Honeypot: people never see or fill it; bots do. */}
      <div className="wl-hp" aria-hidden="true">
        <label>
          {t.honeypot}
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <p className="wl-msg" id="wl-msg" role="status" aria-live="polite" data-state={state.status}>
        {state.message}
      </p>
      <p className="wl-fine">{t.fine}</p>
    </form>
  );
}
