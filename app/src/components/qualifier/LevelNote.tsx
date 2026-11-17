"use client";

import { useState, useTransition } from "react";
import { ackLevelNoteAction } from "@/app/(app)/agentes/qualifier-actions";
import { btn, Notice } from "@/components/email/bits";
import { noteFieldLabel } from "@/lib/qualifier/view";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** "Nível caiu de 3 para 2: site refutado." stays until the sender presses Ok. */
export function LevelNote({ leadId, note }: { leadId: string; note: { from: number; to: number; field: string } }) {
  const t = useT();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <Notice tone="warn">{fill(t.qualifier.levelDrop, { from: note.from, to: note.to, field: noteFieldLabel(note.field, t) })}</Notice>
      </div>
      <button
        type="button"
        disabled={pending}
        className={btn.ghost}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await ackLevelNoteAction(leadId);
            if (r.status === "error") setError(r.message ?? t.qualifier.errors.failed);
          })
        }
      >
        {t.qualifier.levelDropOk}
      </button>
      {error && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
