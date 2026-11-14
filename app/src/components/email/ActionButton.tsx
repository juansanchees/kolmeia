"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { t } from "@/messages/pt";
import { btn } from "./bits";

type Result = { ok: boolean; message?: string };

/**
 * A button that runs one server action (already bound to its arguments), optionally after an inline confirmation,
 * then refreshes the page data and shows the result next to the button.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  confirm,
  variant = "ghost",
  className = "",
}: {
  action: () => Promise<Result>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  variant?: keyof typeof btn;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const run = () =>
    start(async () => {
      setAsking(false);
      const r = await action();
      setResult(r);
      router.refresh();
    });

  if (asking && confirm) {
    return (
      <div role="alertdialog" aria-label={label} className="flex flex-col gap-2 border border-ink bg-surface p-3">
        <p className="text-sm">{confirm}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn.primary} onClick={run} disabled={pending}>
            {t.email.confirm}
          </button>
          <button type="button" className={btn.ghost} onClick={() => setAsking(false)}>
            {t.email.cancel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" className={`${btn[variant]} ${className}`} disabled={pending} onClick={() => (confirm ? setAsking(true) : run())}>
        {pending ? (pendingLabel ?? `${label}…`) : label}
      </button>
      {result?.message && (
        <span role={result.ok ? "status" : "alert"} className={`text-sm ${result.ok ? "text-ok" : "text-danger"}`}>
          {result.message}
        </span>
      )}
      {result && !result.ok && !result.message && (
        <span role="alert" className="text-sm text-danger">
          {t.email.genericError}
        </span>
      )}
    </span>
  );
}
