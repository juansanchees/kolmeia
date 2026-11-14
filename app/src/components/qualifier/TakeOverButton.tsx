"use client";

import { useState, useTransition } from "react";
import { takeOverChargeAction } from "@/app/(app)/agentes/qualifier-actions";
import { btn } from "@/components/email/bits";
import { t } from "@/messages/pt";

const Q = t.qualifier;

/** "Assumir a cobrança": shown to the owner only, next to the no_access pause notice. */
export function TakeOverButton() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        className={btn.primary}
        title={Q.takeOverHelp}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await takeOverChargeAction();
            if (r.status === "error") setError(r.message ?? Q.errors.failed);
          })
        }
      >
        {Q.takeOver}
      </button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
