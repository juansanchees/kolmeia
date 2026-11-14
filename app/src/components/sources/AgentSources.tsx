"use client";

import { useActionState, useState } from "react";
import { saveAgentSources } from "@/app/(app)/leads/buscar/actions";
import { btn, Card, CardTitle, input, Notice } from "@/components/email/bits";
import { Field } from "@/components/ui";
import type { SearchResult } from "@/lib/sources/search";
import { type AgentSourcesView, estimateLabel } from "@/lib/sources/view";
import { t } from "@/messages/pt";

const S = t.sources;
const A = S.agent;
const Q = S.search;

export type { AgentSourcesView };

const area = `${input} min-h-20`;

function Check({ name, label, checked, onChange }: { name: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-[15px] font-semibold">
      <input type="checkbox" name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5" />
      {label}
    </label>
  );
}

/** Per-agent sources. Only the connected providers show; when none is connected there is just a pointer to Configurações. */
export function AgentSources({ agentId, connected, settings }: { agentId: string; connected: { maps: boolean; apollo: boolean }; settings: AgentSourcesView }) {
  const [state, action, pending] = useActionState(saveAgentSources, null as SearchResult | null);
  const [mapsOn, setMapsOn] = useState(settings.maps_on);
  const [mapsTerms, setMapsTerms] = useState(settings.maps_terms.join("\n"));
  const [mapsLocation, setMapsLocation] = useState(settings.maps_location);
  const [max, setMax] = useState(String(settings.maps_max));
  const [apolloOn, setApolloOn] = useState(settings.apollo_on);
  const [apolloLocations, setApolloLocations] = useState(settings.apollo_locations.join("\n"));
  const [apolloNaics, setApolloNaics] = useState(settings.apollo_naics.join("\n"));
  const [apolloPages, setApolloPages] = useState(String(settings.apollo_pages));
  if (!connected.maps && !connected.apollo) {
    return (
      <Card aria-labelledby="agent-sources">
        <CardTitle id="agent-sources">{A.title}</CardTitle>
        <Notice tone="info">{A.noneConnected}</Notice>
      </Card>
    );
  }
  const n = Number(max);
  const maxMissing = max.trim() === "" && state !== null && "error" in state && state.error === "invalid";
  return (
    <Card aria-labelledby="agent-sources">
      <CardTitle id="agent-sources">{A.title}</CardTitle>
      <p className="text-sm">{A.intro}</p>
      <form action={action} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="agent" value={agentId} />
        {connected.maps && <input type="hidden" name="hasMaps" value="1" />}
        {connected.apollo && <input type="hidden" name="hasApollo" value="1" />}
        {connected.maps ? (
          <fieldset className="flex flex-col gap-3 border-0 p-0">
            <legend className="sr-only">{S.providers.apify}</legend>
            <Check name="mapsOn" label={A.mapsOn} checked={mapsOn} onChange={setMapsOn} />
            <p className="text-sm">{S.mapsTerms}</p>
            <Field label={Q.termsLabel} htmlFor="ag-maps-terms">
              <textarea id="ag-maps-terms" name="mapsTerms" className={area} value={mapsTerms} onChange={(e) => setMapsTerms(e.target.value)} />
            </Field>
            <Field label={Q.locationLabel} htmlFor="ag-maps-location">
              <input id="ag-maps-location" name="mapsLocation" className={input} maxLength={120} value={mapsLocation} onChange={(e) => setMapsLocation(e.target.value)} />
            </Field>
            <Field label={Q.maxLabel} htmlFor="ag-maps-max" error={maxMissing ? Q.maxRequired : undefined}>
              <input id="ag-maps-max" name="mapsMax" type="number" inputMode="numeric" min={1} max={200} value={max} onChange={(e) => setMax(e.target.value)} className={`${input} w-28`} />
            </Field>
            {Number.isInteger(n) && n >= 1 && n <= 200 && <p className="font-mono text-xs text-muted">{Q.costPrefix} {estimateLabel("maps", n)}</p>}
          </fieldset>
        ) : null}
        {connected.apollo ? (
          <fieldset className="flex flex-col gap-3 border-0 p-0">
            <legend className="sr-only">{S.providers.apollo}</legend>
            <Check name="apolloOn" label={A.apolloOn} checked={apolloOn} onChange={setApolloOn} />
            <p className="text-sm">{S.apolloTerms}</p>
            <Field label={Q.locationsLabel} htmlFor="ag-apollo-locations">
              <textarea id="ag-apollo-locations" name="apolloLocations" className={area} value={apolloLocations} onChange={(e) => setApolloLocations(e.target.value)} />
            </Field>
            <Field label={Q.naicsLabel} htmlFor="ag-apollo-naics" hint={Q.naicsHint}>
              <textarea id="ag-apollo-naics" name="apolloNaics" className={area} value={apolloNaics} onChange={(e) => setApolloNaics(e.target.value)} aria-describedby="ag-apollo-naics-hint" />
            </Field>
            <Field label={Q.pagesLabel} htmlFor="ag-apollo-pages">
              <input id="ag-apollo-pages" name="apolloPages" type="number" inputMode="numeric" min={1} max={4} value={apolloPages} onChange={(e) => setApolloPages(e.target.value)} className={`${input} w-28`} />
            </Field>
          </fieldset>
        ) : null}
        {state && ("ok" in state ? <Notice tone="ok">{A.saved}</Notice> : <Notice role="alert">{state.error === "invalid" ? A.incomplete : Q.errors[state.error]}</Notice>)}
        <div>
          <button type="submit" className={btn.primary} disabled={pending}>
            {pending ? A.saving : A.save}
          </button>
        </div>
      </form>
    </Card>
  );
}
