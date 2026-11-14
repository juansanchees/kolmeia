"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { deleteSourceKey, saveSourceCap, saveSourceKey } from "@/app/(app)/configuracoes/fontes/actions";
import { btn, Card, CardTitle, input, Notice } from "@/components/email/bits";
import { Field } from "@/components/ui";
import type { SourceResult } from "@/lib/sources/connections";
import { fill, t } from "@/messages/pt";

const S = t.sources;
type P = "apify" | "apollo";

export type ConnectionView = {
  provider: P;
  last4: string | null; // null = not connected
  cap: number | null; // USD (apify) or searches (apollo)
  today: number | null; // USD spent (apify) or searches done (apollo)
};

const money = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Result({ r }: { r: SourceResult | null }) {
  if (!r) return null;
  if ("ok" in r) return <Notice tone="ok">{S.saved}</Notice>;
  return <Notice role="alert">{S.errors[r.error]}</Notice>;
}

function KeyForm({ provider, connected }: { provider: P; connected: boolean }) {
  const [state, action, pending] = useActionState(saveSourceKey, null);
  const id = `key-${provider}`;
  return (
    <form action={action} className="flex flex-col gap-3" autoComplete="off" noValidate>
      <input type="hidden" name="provider" value={provider} />
      <Field label={S.keyLabel} htmlFor={id}>
        <input id={id} name="key" type="password" autoComplete="new-password" spellCheck={false} className={input} placeholder={S.keyPlaceholder} />
      </Field>
      <Result r={state} />
      <div>
        <button type="submit" className={connected ? btn.ghost : btn.primary} disabled={pending}>
          {pending ? S.connecting : connected ? S.replace : S.connect}
        </button>
      </div>
    </form>
  );
}

function CapForm({ provider, cap }: { provider: P; cap: number }) {
  const [state, action, pending] = useActionState(saveSourceCap, null);
  const id = `cap-${provider}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" noValidate>
      <input type="hidden" name="provider" value={provider} />
      <label htmlFor={id} className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{provider === "apify" ? S.capUsdLabel : S.capCallsLabel}</span>
        <input
          id={id}
          name="cap"
          type="number"
          inputMode="decimal"
          min={provider === "apify" ? 0.5 : 1}
          max={provider === "apify" ? 50 : 200}
          step={provider === "apify" ? 0.5 : 1}
          defaultValue={cap}
          className={`${input} w-28`}
          aria-describedby={`${id}-hint`}
        />
      </label>
      <button type="submit" className={btn.ghost} disabled={pending}>
        {S.saveCap}
      </button>
      <span id={`${id}-hint`} className="w-full text-[13px] text-muted">
        {S.capHint[provider]}
      </span>
      <Result r={state} />
    </form>
  );
}

function Disconnect({ provider }: { provider: P }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SourceResult | null>(null);
  const run = () =>
    start(async () => {
      setAsking(false);
      setResult(await deleteSourceKey(provider));
      router.refresh();
    });
  if (asking) {
    return (
      <div role="alertdialog" aria-label={S.disconnect} className="flex flex-col gap-2 border border-ink bg-surface p-3">
        <p className="text-sm">{S.disconnectConfirm}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn.primary} onClick={run} disabled={pending}>
            {S.confirm}
          </button>
          <button type="button" className={btn.ghost} onClick={() => setAsking(false)}>
            {S.cancel}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div>
        <button type="button" className={btn.danger} disabled={pending} onClick={() => setAsking(true)}>
          {S.disconnect}
        </button>
      </div>
      {result && "error" in result && <Notice role="alert">{S.errors[result.error]}</Notice>}
    </div>
  );
}

/** One provider: masked key, cap, today's spend, terms. Owner edits; the sdr only reads. */
export function ConnectionCard({ view, isOwner }: { view: ConnectionView; isOwner: boolean }) {
  const { provider, last4, cap, today } = view;
  const connected = last4 !== null;
  const atCap = connected && cap !== null && today !== null && (provider === "apify" ? today + 0.5 > cap : today >= cap);
  return (
    <Card aria-labelledby={`src-${provider}`} className="flex-[1_1_340px]">
      <CardTitle id={`src-${provider}`}>{S.providers[provider]}</CardTitle>
      <p className="text-sm">{provider === "apify" ? S.mapsTerms : S.apolloTerms}</p>
      {provider === "apify" && <p className="text-sm text-muted">{S.noSocial}</p>}

      {connected ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-base">{fill(S.keyMasked, { last4: last4 })}</span>
          {today !== null && cap !== null && (
            <span className="text-sm">
              {provider === "apify" ? fill(S.todayUsd, { spent: money(today), cap: money(cap) }) : fill(S.todayCalls, { n: today, cap })}
            </span>
          )}
          {atCap && <Notice>{S.capHit}</Notice>}
        </div>
      ) : (
        <p className="text-sm text-muted">{S.notConnected}</p>
      )}

      {isOwner ? (
        <>
          <KeyForm provider={provider} connected={connected} />
          {connected && cap !== null && <CapForm provider={provider} cap={cap} />}
          {connected && <Disconnect provider={provider} />}
        </>
      ) : (
        <p className="text-sm text-muted">{S.readOnly}</p>
      )}
    </Card>
  );
}
