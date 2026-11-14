"use client";

import { useActionState, useState } from "react";
import { enqueueApollo, enqueueMaps } from "@/app/(app)/leads/buscar/actions";
import { btn, Card, CardTitle, input, Notice } from "@/components/email/bits";
import { Field } from "@/components/ui";
import type { SearchResult } from "@/lib/sources/search";
import { estimateLabel } from "@/lib/sources/view";
import { t } from "@/messages/pt";

const S = t.sources;
const Q = S.search;

function Result({ r }: { r: SearchResult | null }) {
  if (!r) return null;
  if ("ok" in r) return <Notice tone="ok">{Q.queuedOk}</Notice>;
  return <Notice role="alert">{Q.errors[r.error]}</Notice>;
}

const area = `${input} min-h-24`;

/** One search form: the terms copy first, then the fields, the cost estimate and the button. */
export function SearchForm({ kind }: { kind: "maps" | "apollo" }) {
  const [state, action, pending] = useActionState(kind === "maps" ? enqueueMaps : enqueueApollo, null);
  const [max, setMax] = useState("50");
  const n = Number(max);
  const estimate = kind === "maps" ? (Number.isInteger(n) && n >= 1 && n <= 200 ? estimateLabel("maps", n) : null) : estimateLabel("apollo", 25);
  return (
    <Card id={kind} aria-labelledby={`buscar-${kind}`} className="flex-[1_1_340px]">
      <CardTitle id={`buscar-${kind}`}>{kind === "maps" ? Q.maps : Q.apollo}</CardTitle>
      <p className="text-sm">{kind === "maps" ? S.mapsTerms : S.apolloTerms}</p>
      {kind === "maps" && <p className="text-sm text-muted">{S.noSocial}</p>}
      <form action={action} className="flex flex-col gap-3" noValidate>
        {kind === "maps" ? (
          <>
            <Field label={Q.termsLabel} htmlFor="maps-terms" hint={Q.termsHint}>
              <textarea id="maps-terms" name="terms" className={area} aria-describedby="maps-terms-hint" />
            </Field>
            <Field label={Q.locationLabel} htmlFor="maps-location" hint={Q.locationHint}>
              <input id="maps-location" name="location" className={input} maxLength={120} aria-describedby="maps-location-hint" />
            </Field>
            <Field label={Q.maxLabel} htmlFor="maps-max">
              <input id="maps-max" name="max" type="number" inputMode="numeric" min={1} max={200} step={1} value={max} onChange={(e) => setMax(e.target.value)} className={`${input} w-28`} />
            </Field>
          </>
        ) : (
          <>
            <Field label={Q.locationsLabel} htmlFor="apollo-locations" hint={Q.locationHint}>
              <textarea id="apollo-locations" name="locations" className={area} aria-describedby="apollo-locations-hint" />
            </Field>
            <Field label={Q.naicsLabel} htmlFor="apollo-naics" hint={Q.naicsHint}>
              <textarea id="apollo-naics" name="naics" className={area} inputMode="numeric" aria-describedby="apollo-naics-hint" />
            </Field>
            <Field label={Q.pagesLabel} htmlFor="apollo-pages">
              <input id="apollo-pages" name="pages" type="number" inputMode="numeric" min={1} max={4} step={1} defaultValue={1} className={`${input} w-28`} />
            </Field>
          </>
        )}
        <Field label={Q.labelLabel} htmlFor={`${kind}-label`}>
          <input id={`${kind}-label`} name="label" className={input} maxLength={60} />
        </Field>
        {estimate && <p className="font-mono text-xs text-muted">{kind === "maps" ? `${Q.costPrefix} ${estimate}` : estimate}</p>}
        <Result r={state} />
        <div>
          <button type="submit" className={btn.primary} disabled={pending}>
            {pending ? Q.sending : Q.send}
          </button>
        </div>
      </form>
    </Card>
  );
}
