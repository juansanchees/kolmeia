"use client";

import { useState, useTransition } from "react";
import { checkEmailsAction, findEmailAction } from "@/app/(app)/leads/email-actions";
import { Button, Notice } from "@/components/ui";
import type { FindEmailResult } from "@/lib/leads/email-cascade";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

export function summary(results: FindEmailResult[], t: Messages): string {
  const FE = t.leads.findEmail;
  const n = (s: FindEmailResult["step"]) => results.filter((r) => r.step === s).length;
  return fill(FE.summary, { site: n("site"), queued: n("queued"), pattern: n("pattern"), verifier: n("verifier"), none: n("none") });
}

/** One lead's result: which step found what. */
function ResultLine({ r }: { r: FindEmailResult }) {
  const t = useT();
  const FE = t.leads.findEmail;
  return (
    <span>
      <span className="font-semibold">{FE.steps[r.step]}</span>
      {r.email && <> · <span className="font-mono">{r.email}</span></>}
      {r.step === "pattern" && r.guesses.length > 0 && <> · <span className="font-mono">{r.guesses.join(", ")}</span></>}
      {r.reason && <> · {FE.reasons[r.reason]}</>}
    </span>
  );
}

/** "Checar e-mails" (free: syntax + DNS) and "Achar e-mail" (the cascade) for the selected leads, or for one lead. */
export function EmailTools({ selected, onDone, single = false }: { selected: string[]; onDone?: () => void; single?: boolean }) {
  const t = useT();
  const Q = t.leads.emailQuality;
  const FE = t.leads.findEmail;
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "info"; node: React.ReactNode } | null>(null);
  const none = selected.length === 0;
  const count = single || none ? "" : ` (${selected.length})`;

  const check = () =>
    start(async () => {
      const r = await checkEmailsAction(selected);
      setMsg(r.ok ? { tone: "ok", node: r.message } : { tone: "warn", node: r.error });
      if (r.ok) onDone?.();
    });
  const find = () =>
    start(async () => {
      const r = await findEmailAction(selected);
      if (!r.ok) return setMsg({ tone: "warn", node: r.error });
      const offNote = !r.verifierConfigured && r.results.some((x) => x.step === "pattern") ? <span className="block">{FE.verifierOff}</span> : null;
      setMsg({
        tone: "info",
        node: (
          <>
            {single && r.results[0] ? <ResultLine r={r.results[0]} /> : summary(r.results, t)}
            {offNote}
          </>
        ),
      });
      onDone?.();
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={pending || none} onClick={check}>
          {pending ? Q.checking : `${Q.check}${count}`}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={pending || none} onClick={find}>
          {pending ? FE.finding : `${FE.button}${count}`}
        </Button>
      </div>
      {msg && (
        <Notice tone={msg.tone === "warn" ? "danger" : msg.tone} role={msg.tone === "warn" ? "alert" : "status"}>
          {msg.node}
        </Notice>
      )}
    </div>
  );
}
