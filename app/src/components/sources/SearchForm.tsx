"use client";

import { useActionState, useState } from "react";
import { enqueueApollo, enqueueMaps, enqueueShovels } from "@/app/(app)/leads/buscar/actions";
import { btn, Card, CardTitle, input, Notice } from "@/components/email/bits";
import { Field } from "@/components/ui";
import type { SearchResult } from "@/lib/sources/search";
import { estimateLabel, SHOVELS_TAGS } from "@/lib/sources/view";
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
export function SearchForm({ kind }: { kind: "maps" | "apollo" | "shovels" }) {
  const [state, action, pending] = useActionState(kind === "maps" ? enqueueMaps : kind === "shovels" ? enqueueShovels : enqueueApollo, null);
  const [max, setMax] = useState(kind === "shovels" ? "25" : "50");
  const [place, setPlace] = useState("");
  const [tag, setTag] = useState<string>("all");
  const [terms, setTerms] = useState("");
  const [location, setLocation] = useState("");
  const [locations, setLocations] = useState("");
  const [naics, setNaics] = useState("");
  const [pages, setPages] = useState("1");
  const [label, setLabel] = useState("");
  const n = Number(max);
  const estimate = kind === "maps" ? (Number.isInteger(n) && n >= 1 && n <= 200 ? estimateLabel("maps", n) : null) : estimateLabel(kind, 25);
  return (
    <Card id={kind} aria-labelledby={`buscar-${kind}`} className="flex-[1_1_340px]">
      <CardTitle id={`buscar-${kind}`}>{Q[kind]}</CardTitle>
      <p className="text-sm">{kind === "maps" ? S.mapsTerms : kind === "shovels" ? S.shovelsTerms : S.apolloTerms}</p>
      {kind === "maps" && <p className="text-sm text-muted">{S.noSocial}</p>}
      <form action={action} className="flex flex-col gap-3" noValidate>
        {kind === "maps" ? (
          <>
            <Field label={Q.termsLabel} htmlFor="maps-terms" hint={Q.termsHint}>
              <textarea id="maps-terms" name="terms" value={terms} onChange={(e) => setTerms(e.target.value)} className={area} aria-describedby="maps-terms-hint" />
            </Field>
            <Field label={Q.locationLabel} htmlFor="maps-location" hint={Q.locationHint}>
              <input id="maps-location" name="location" value={location} onChange={(e) => setLocation(e.target.value)} className={input} maxLength={120} aria-describedby="maps-location-hint" />
            </Field>
            <Field label={Q.maxLabel} htmlFor="maps-max" error={max.trim() === "" && state !== null && "error" in state && state.error === "invalid" ? Q.maxRequired : undefined}>
              <input id="maps-max" name="max" type="number" inputMode="numeric" min={1} max={200} step={1} value={max} onChange={(e) => setMax(e.target.value)} className={`${input} w-28`} />
            </Field>
          </>
        ) : kind === "shovels" ? (
          <>
            <Field label={Q.placeLabel} htmlFor="shovels-place" hint={Q.placeHint}>
              <input id="shovels-place" name="place" value={place} onChange={(e) => setPlace(e.target.value)} className={input} maxLength={80} aria-describedby="shovels-place-hint" />
            </Field>
            <Field label={Q.tagLabel} htmlFor="shovels-tag">
              <select id="shovels-tag" name="tag" value={tag} onChange={(e) => setTag(e.target.value)} className={input}>
                {SHOVELS_TAGS.map((k) => (
                  <option key={k} value={k}>
                    {Q.tags[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={Q.recordsLabel} htmlFor="shovels-max">
              <input id="shovels-max" name="max" type="number" inputMode="numeric" min={1} max={100} step={1} value={max} onChange={(e) => setMax(e.target.value)} className={`${input} w-28`} />
            </Field>
          </>
        ) : (
          <>
            <Field label={Q.locationsLabel} htmlFor="apollo-locations" hint={Q.locationHint}>
              <textarea id="apollo-locations" name="locations" value={locations} onChange={(e) => setLocations(e.target.value)} className={area} aria-describedby="apollo-locations-hint" />
            </Field>
            <Field label={Q.naicsLabel} htmlFor="apollo-naics" hint={Q.naicsHint}>
              <textarea id="apollo-naics" name="naics" value={naics} onChange={(e) => setNaics(e.target.value)} className={area} inputMode="numeric" aria-describedby="apollo-naics-hint" />
            </Field>
            <Field label={Q.pagesLabel} htmlFor="apollo-pages">
              <input id="apollo-pages" name="pages" type="number" inputMode="numeric" min={1} max={4} step={1} value={pages} onChange={(e) => setPages(e.target.value)} className={`${input} w-28`} />
            </Field>
          </>
        )}
        <Field label={Q.labelLabel} htmlFor={`${kind}-label`}>
          <input id={`${kind}-label`} name="label" value={label} onChange={(e) => setLabel(e.target.value)} className={input} maxLength={60} />
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
