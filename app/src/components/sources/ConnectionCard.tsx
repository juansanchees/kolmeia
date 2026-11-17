"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { deleteSourceKey, saveSourceCap, saveSourceKey } from "@/app/(app)/configuracoes/fontes/actions";
import { btn, Card, CardTitle, input, Notice } from "@/components/email/bits";
import { Field } from "@/components/ui";
import type { SourceResult } from "@/lib/sources/connections";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

type P = "apify" | "apollo" | "shovels" | "rapidapi";
/** RapidAPI has a second cap (company sites read per 30 days) on the same connection. */
type CapP = P | "rapidapi_sites";

export type ConnectionView = {
  provider: P;
  last4: string | null; // null = not connected
  cap: number | null; // USD/day (apify), searches/day (apollo) or records per 30 days (shovels)
  today: number | null; // USD spent today (apify), searches today (apollo) or records in the last 30 days (shovels)
  sites?: { cap: number | null; used: number | null }; // rapidapi only: company sites read per 30 days
};
// [label, min, max, step] of each cap (the database repeats the bounds)
const capInput = (S: Messages["sources"]): Record<CapP, [string, number, number, number]> => ({
  apify: [S.capUsdLabel, 0.5, 50, 0.5],
  apollo: [S.capCallsLabel, 1, 200, 1],
  shovels: [S.capRecordsLabel, 50, 50000, 50],
  rapidapi: [S.capB2bLabel, 1, 5000, 1],
  rapidapi_sites: [S.capSitesLabel, 1, 50000, 1],
});

const money = (n: number, intl: string) => n.toLocaleString(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Result({ r }: { r: SourceResult | null }) {
  const t = useT();
  const S = t.sources;
  if (!r) return null;
  if ("ok" in r) return <Notice tone="ok">{S.saved}</Notice>;
  return <Notice role="alert">{S.errors[r.error]}</Notice>;
}

function KeyForm({ provider, connected }: { provider: P; connected: boolean }) {
  const t = useT();
  const S = t.sources;
  const [key, setKey] = useState("");
  const [state, action, pending] = useActionState(async (prev: SourceResult | null, fd: FormData) => {
    const r = await saveSourceKey(prev, fd);
    if (r && "ok" in r) setKey(""); // clear the secret only after a successful save
    return r;
  }, null);
  const id = `key-${provider}`;
  return (
    <form action={action} className="flex flex-col gap-3" autoComplete="off" noValidate>
      <input type="hidden" name="provider" value={provider} />
      <Field label={S.keyLabel} htmlFor={id}>
        <input id={id} name="key" type="password" autoComplete="new-password" spellCheck={false} className={input} placeholder={S.keyPlaceholder} value={key} onChange={(e) => setKey(e.target.value)} />
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

function CapForm({ provider, cap }: { provider: CapP; cap: number }) {
  const t = useT();
  const S = t.sources;
  const [text, min, max, step] = capInput(t.sources)[provider];
  const [state, action, pending] = useActionState(saveSourceCap, null);
  const [value, setValue] = useState(String(cap));
  const id = `cap-${provider}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" noValidate>
      <input type="hidden" name="provider" value={provider} />
      <label htmlFor={id} className="flex flex-col gap-1">
        <span className="font-mono text-xs text-muted">{text}</span>
        <input
          id={id}
          name="cap"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
  const t = useT();
  const S = t.sources;
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
  const t = useT();
  const S = t.sources;
  const { provider, last4, cap, today, sites } = view;
  const connected = last4 !== null;
  // 0.5 = the smallest Apify run reserve (APIFY_MIN_CHARGE_USD): under that margin no new Maps search fits today.
  const atCap = connected && cap !== null && today !== null && (provider === "apify" ? today + 0.5 > cap : today >= cap);
  return (
    <Card aria-labelledby={`src-${provider}`} className="flex-[1_1_340px]">
      <CardTitle id={`src-${provider}`}>{S.providers[provider]}</CardTitle>
      <p className="text-sm">{provider === "apify" ? S.mapsTerms : provider === "shovels" ? S.shovelsTerms : provider === "rapidapi" ? S.rapidapiTerms : S.apolloTerms}</p>
      {provider === "apify" && <p className="text-sm text-muted">{S.noSocial}</p>}

      {connected ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-base">{fill(S.keyMasked, { last4: last4 })}</span>
          {today !== null && cap !== null && (
            <span className="text-sm">
              {provider === "apify"
                ? fill(S.todayUsd, { spent: money(today, t.intl), cap: money(cap, t.intl) })
                : provider === "shovels"
                  ? fill(S.monthRecords, { n: today, cap })
                  : provider === "rapidapi"
                    ? fill(S.monthCalls, { n: today, cap })
                    : fill(S.todayCalls, { n: today, cap })}
            </span>
          )}
          {sites && sites.used !== null && sites.cap !== null && <span className="text-sm">{fill(S.monthSites, { n: sites.used, cap: sites.cap })}</span>}
          {(atCap || (sites && sites.used !== null && sites.cap !== null && sites.used >= sites.cap)) && (
            <Notice>{provider === "shovels" || provider === "rapidapi" ? S.capHitMonth : S.capHit}</Notice>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">{S.notConnected}</p>
      )}

      {isOwner ? (
        <>
          <KeyForm provider={provider} connected={connected} />
          {connected && cap !== null && <CapForm provider={provider} cap={cap} />}
          {connected && sites && sites.cap !== null && <CapForm provider="rapidapi_sites" cap={sites.cap} />}
          {connected && <Disconnect provider={provider} />}
        </>
      ) : (
        <p className="text-sm text-muted">{S.readOnly}</p>
      )}
    </Card>
  );
}
