"use client";

import { useActionState, useState } from "react";
import { saveAgentSources } from "@/app/(app)/leads/buscar/actions";
import { Button, Card, Field, Notice, Select, TextArea, TextInput } from "@/components/ui";
import type { SearchResult } from "@/lib/sources/search";
import { type AgentSourcesView, estimateLabel } from "@/lib/sources/view";
import { useT } from "@/lib/i18n/client";

export type { AgentSourcesView };

function Check({ name, label, checked, onChange }: { name: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-[14px] border-2 border-line bg-surface px-4 text-base font-semibold hover:border-honey-edge hover:bg-[#fffaeb]">
      <input type="checkbox" name={name} checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-[#0f1b3d]" />
      {label}
    </label>
  );
}

/** Per-agent sources. Only the connected providers show; when none is connected there is just a pointer to Configurações. */
export function AgentSources({ agentId, connected, settings }: { agentId: string; connected: { maps: boolean; apollo: boolean }; settings: AgentSourcesView }) {
  const t = useT();
  const S = t.sources;
  const A = S.agent;
  const Q = S.search;
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
      <Card aria-labelledby="agent-sources" className="flex flex-col gap-4 p-6">
        <h3 id="agent-sources" className="font-body text-xl font-semibold normal-case tracking-normal">{A.title}</h3>
        <Notice tone="info">{A.noneConnected}</Notice>
      </Card>
    );
  }
  const n = Number(max);
  const maxMissing = max.trim() === "" && state !== null && "error" in state && state.error === "invalid";
  return (
    <Card aria-labelledby="agent-sources" className="flex flex-col gap-4 p-6">
      <h3 id="agent-sources" className="font-body text-xl font-semibold normal-case tracking-normal">{A.title}</h3>
      <p className="m-0 text-base">{A.intro}</p>
      <form action={action} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="agent" value={agentId} />
        {connected.maps && <input type="hidden" name="hasMaps" value="1" />}
        {connected.apollo && <input type="hidden" name="hasApollo" value="1" />}
        {connected.maps ? (
          <fieldset className="flex flex-col gap-3 border-0 p-0">
            <legend className="sr-only">{S.providers.apify}</legend>
            <Check name="mapsOn" label={A.mapsOn} checked={mapsOn} onChange={setMapsOn} />
            <p className="m-0 text-base">{S.mapsTerms}</p>
            <Field label={Q.termsLabel} htmlFor="ag-maps-terms">
              <TextArea id="ag-maps-terms" name="mapsTerms" value={mapsTerms} onChange={(e) => setMapsTerms(e.target.value)} />
            </Field>
            <Field label={Q.locationLabel} htmlFor="ag-maps-location">
              <TextInput id="ag-maps-location" name="mapsLocation" maxLength={120} value={mapsLocation} onChange={(e) => setMapsLocation(e.target.value)} />
            </Field>
            <Field label={Q.maxLabel} htmlFor="ag-maps-max" error={maxMissing ? Q.maxRequired : undefined}>
              <TextInput id="ag-maps-max" name="mapsMax" type="number" inputMode="numeric" min={1} max={200} value={max} onChange={(e) => setMax(e.target.value)} className="w-32!" />
            </Field>
            {Number.isInteger(n) && n >= 1 && n <= 200 && <p className="font-mono text-sm text-muted">{Q.costPrefix} {estimateLabel("maps", n, t)}</p>}
          </fieldset>
        ) : null}
        {connected.apollo ? (
          <fieldset className="flex flex-col gap-3 border-0 p-0">
            <legend className="sr-only">{S.providers.apollo}</legend>
            <Check name="apolloOn" label={A.apolloOn} checked={apolloOn} onChange={setApolloOn} />
            <p className="m-0 text-base">{S.apolloTerms}</p>
            <Field label={Q.locationsLabel} htmlFor="ag-apollo-locations">
              <TextArea id="ag-apollo-locations" name="apolloLocations" value={apolloLocations} onChange={(e) => setApolloLocations(e.target.value)} />
            </Field>
            <Field label={Q.naicsLabel} htmlFor="ag-apollo-naics" hint={Q.naicsHint}>
              <TextArea id="ag-apollo-naics" name="apolloNaics" value={apolloNaics} onChange={(e) => setApolloNaics(e.target.value)} aria-describedby="ag-apollo-naics-hint" />
            </Field>
            <Field label={Q.pagesLabel} htmlFor="ag-apollo-pages">
              <TextInput id="ag-apollo-pages" name="apolloPages" type="number" inputMode="numeric" min={1} max={4} value={apolloPages} onChange={(e) => setApolloPages(e.target.value)} className="w-32!" />
            </Field>
          </fieldset>
        ) : null}
        {state && ("ok" in state ? <Notice tone="ok">{A.saved}</Notice> : <Notice tone="warn" role="alert">{state.error === "invalid" ? A.incomplete : Q.errors[state.error]}</Notice>)}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? A.saving : A.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}
