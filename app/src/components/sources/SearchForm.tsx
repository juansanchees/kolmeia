"use client";

import { useActionState, useState } from "react";
import { enqueueApollo, enqueueB2b, enqueueMaps, enqueueShovels } from "@/app/(app)/leads/buscar/actions";
import { Button, Card, Field, Notice, Select, TextArea, TextInput } from "@/components/ui";
import type { SearchResult } from "@/lib/sources/search";
import { B2B_ROLES, B2B_SECTORS, B2B_SIZES, B2B_STATES, estimateLabel, SHOVELS_TAGS } from "@/lib/sources/view";
import { useT } from "@/lib/i18n/client";

function Result({ r }: { r: SearchResult | null }) {
  const Q = useT().sources.search;
  if (!r) return null;
  if ("ok" in r) return <Notice tone="ok">{Q.queuedOk}</Notice>;
  return <Notice tone="warn" role="alert">{Q.errors[r.error]}</Notice>;
}

/** One search form: the terms copy first, then the fields, the cost estimate and the button. */
export function SearchForm({ kind }: { kind: "maps" | "apollo" | "shovels" | "b2b" }) {
  const t = useT();
  const S = t.sources;
  const Q = S.search;
  const [state, action, pending] = useActionState({ maps: enqueueMaps, apollo: enqueueApollo, shovels: enqueueShovels, b2b: enqueueB2b }[kind], null);
  const [max, setMax] = useState(kind === "shovels" ? "25" : "50");
  const [place, setPlace] = useState("");
  const [tag, setTag] = useState<string>("all");
  const [terms, setTerms] = useState("");
  const [location, setLocation] = useState("");
  const [locations, setLocations] = useState("");
  const [naics, setNaics] = useState("");
  const [pages, setPages] = useState("1");
  const [label, setLabel] = useState("");
  const [b2b, setB2b] = useState({ state: "MA", sector: "construction", size: "11-50", role: "founder" });
  const n = Number(max);
  const estimate = kind === "maps" ? (Number.isInteger(n) && n >= 1 && n <= 200 ? estimateLabel("maps", n, t) : null) : estimateLabel(kind, 25, t);
  return (
    <Card id={kind} aria-labelledby={`buscar-${kind}`} className="k-in flex flex-[1_1_340px] flex-col gap-4 p-6">
      <h3 id={`buscar-${kind}`} className="font-body text-xl font-semibold normal-case tracking-normal">{Q[kind]}</h3>
      <p className="m-0 text-base">{kind === "maps" ? S.mapsTerms : kind === "shovels" ? S.shovelsTerms : kind === "b2b" ? S.rapidapiTerms : S.apolloTerms}</p>
      {kind === "maps" && <p className="m-0 text-base text-muted">{S.noSocial}</p>}
      <form action={action} className="flex flex-col gap-3" noValidate>
        {kind === "maps" ? (
          <>
            <Field label={Q.termsLabel} htmlFor="maps-terms" hint={Q.termsHint}>
              <TextArea id="maps-terms" name="terms" value={terms} onChange={(e) => setTerms(e.target.value)} aria-describedby="maps-terms-hint" />
            </Field>
            <Field label={Q.locationLabel} htmlFor="maps-location" hint={Q.locationHint}>
              <TextInput id="maps-location" name="location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={120} aria-describedby="maps-location-hint" />
            </Field>
            <Field label={Q.maxLabel} htmlFor="maps-max" error={max.trim() === "" && state !== null && "error" in state && state.error === "invalid" ? Q.maxRequired : undefined}>
              <TextInput id="maps-max" name="max" type="number" inputMode="numeric" min={1} max={200} step={1} value={max} onChange={(e) => setMax(e.target.value)} className="w-32!" />
            </Field>
          </>
        ) : kind === "shovels" ? (
          <>
            <Field label={Q.placeLabel} htmlFor="shovels-place" hint={Q.placeHint}>
              <TextInput id="shovels-place" name="place" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={80} aria-describedby="shovels-place-hint" />
            </Field>
            <Field label={Q.tagLabel} htmlFor="shovels-tag">
              <Select id="shovels-tag" name="tag" value={tag} onChange={(e) => setTag(e.target.value)}>
                {SHOVELS_TAGS.map((k) => (
                  <option key={k} value={k}>
                    {Q.tags[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={Q.recordsLabel} htmlFor="shovels-max">
              <TextInput id="shovels-max" name="max" type="number" inputMode="numeric" min={1} max={100} step={1} value={max} onChange={(e) => setMax(e.target.value)} className="w-32!" />
            </Field>
          </>
        ) : kind === "b2b" ? (
          <>
            {(
              [
                ["state", Q.stateLabel, B2B_STATES, Q.states],
                ["sector", Q.sectorLabel, B2B_SECTORS, Q.sectors],
                ["size", Q.sizeLabel, B2B_SIZES, null],
                ["role", Q.roleLabel, B2B_ROLES, Q.roles],
              ] as const
            ).map(([name, text, values, labels]) => (
              <Field key={name} label={text} htmlFor={`b2b-${name}`}>
                <Select id={`b2b-${name}`} name={name} value={b2b[name]} onChange={(e) => setB2b({ ...b2b, [name]: e.target.value })}>
                  {values.map((v) => (
                    <option key={v} value={v}>
                      {labels ? (labels as Record<string, string>)[v] : v}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </>
        ) : (
          <>
            <Field label={Q.locationsLabel} htmlFor="apollo-locations" hint={Q.locationHint}>
              <TextArea id="apollo-locations" name="locations" value={locations} onChange={(e) => setLocations(e.target.value)} aria-describedby="apollo-locations-hint" />
            </Field>
            <Field label={Q.naicsLabel} htmlFor="apollo-naics" hint={Q.naicsHint}>
              <TextArea id="apollo-naics" name="naics" value={naics} onChange={(e) => setNaics(e.target.value)} inputMode="numeric" aria-describedby="apollo-naics-hint" />
            </Field>
            <Field label={Q.pagesLabel} htmlFor="apollo-pages">
              <TextInput id="apollo-pages" name="pages" type="number" inputMode="numeric" min={1} max={4} step={1} value={pages} onChange={(e) => setPages(e.target.value)} className="w-32!" />
            </Field>
          </>
        )}
        <Field label={Q.labelLabel} htmlFor={`${kind}-label`}>
          <TextInput id={`${kind}-label`} name="label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </Field>
        {estimate && <p className="font-mono text-sm text-muted">{kind === "maps" ? `${Q.costPrefix} ${estimate}` : estimate}</p>}
        <Result r={state} />
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? Q.sending : Q.send}
          </Button>
        </div>
      </form>
    </Card>
  );
}
