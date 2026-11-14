"use client";

import { useActionState, useState } from "react";
import { saveAgentSources } from "@/app/(app)/leads/buscar/actions";
import { btn, Card, CardTitle, input, Notice } from "@/components/email/bits";
import { Field } from "@/components/ui";
import type { SearchResult } from "@/lib/sources/search";
import { estimateLabel } from "@/lib/sources/view";
import { t } from "@/messages/pt";

const S = t.sources;
const A = S.agent;
const Q = S.search;

export type AgentSourcesView = {
  maps_on: boolean;
  maps_terms: string[];
  maps_location: string;
  maps_max: number;
  apollo_on: boolean;
  apollo_locations: string[];
  apollo_naics: string[];
  apollo_pages: number;
};

export const DEFAULT_AGENT_SOURCES: AgentSourcesView = {
  maps_on: false,
  maps_terms: [],
  maps_location: "",
  maps_max: 50,
  apollo_on: false,
  apollo_locations: [],
  apollo_naics: [],
  apollo_pages: 1,
};

const area = `${input} min-h-20`;

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-[15px] font-semibold">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-5" />
      {label}
    </label>
  );
}

/** Per-agent sources. Only the connected providers show; when none is connected there is just a pointer to Configurações. */
export function AgentSources({ agentId, connected, settings }: { agentId: string; connected: { maps: boolean; apollo: boolean }; settings: AgentSourcesView }) {
  const [state, action, pending] = useActionState(saveAgentSources, null as SearchResult | null);
  const [max, setMax] = useState(String(settings.maps_max));
  if (!connected.maps && !connected.apollo) {
    return (
      <Card aria-labelledby="agent-sources">
        <CardTitle id="agent-sources">{A.title}</CardTitle>
        <Notice tone="info">{A.noneConnected}</Notice>
      </Card>
    );
  }
  const n = Number(max);
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
            <Check name="mapsOn" label={A.mapsOn} defaultChecked={settings.maps_on} />
            <p className="text-sm">{S.mapsTerms}</p>
            <Field label={Q.termsLabel} htmlFor="ag-maps-terms">
              <textarea id="ag-maps-terms" name="mapsTerms" className={area} defaultValue={settings.maps_terms.join("\n")} />
            </Field>
            <Field label={Q.locationLabel} htmlFor="ag-maps-location">
              <input id="ag-maps-location" name="mapsLocation" className={input} maxLength={120} defaultValue={settings.maps_location} />
            </Field>
            <Field label={Q.maxLabel} htmlFor="ag-maps-max">
              <input id="ag-maps-max" name="mapsMax" type="number" inputMode="numeric" min={1} max={200} value={max} onChange={(e) => setMax(e.target.value)} className={`${input} w-28`} />
            </Field>
            {Number.isInteger(n) && n >= 1 && n <= 200 && <p className="font-mono text-xs text-muted">{Q.costPrefix} {estimateLabel("maps", n)}</p>}
          </fieldset>
        ) : null}
        {connected.apollo ? (
          <fieldset className="flex flex-col gap-3 border-0 p-0">
            <legend className="sr-only">{S.providers.apollo}</legend>
            <Check name="apolloOn" label={A.apolloOn} defaultChecked={settings.apollo_on} />
            <p className="text-sm">{S.apolloTerms}</p>
            <Field label={Q.locationsLabel} htmlFor="ag-apollo-locations">
              <textarea id="ag-apollo-locations" name="apolloLocations" className={area} defaultValue={settings.apollo_locations.join("\n")} />
            </Field>
            <Field label={Q.naicsLabel} htmlFor="ag-apollo-naics" hint={Q.naicsHint}>
              <textarea id="ag-apollo-naics" name="apolloNaics" className={area} defaultValue={settings.apollo_naics.join("\n")} aria-describedby="ag-apollo-naics-hint" />
            </Field>
            <Field label={Q.pagesLabel} htmlFor="ag-apollo-pages">
              <input id="ag-apollo-pages" name="apolloPages" type="number" inputMode="numeric" min={1} max={4} defaultValue={settings.apollo_pages} className={`${input} w-28`} />
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
