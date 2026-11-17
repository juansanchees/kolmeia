"use client";

import { useState, useTransition } from "react";
import { takeOverChargeAction } from "@/app/(app)/agentes/qualifier-actions";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

/** "Assumir a cobrança": shown to the owner only, next to the no_access pause notice. */
export function TakeOverButton() {
  const t = useT();
  const Q = t.qualifier;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        disabled={pending}
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
      </Button>
      {error && (
        <span role="alert" className="text-base text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
