"use server";

import { revalidatePath } from "next/cache";
import { enqueueApolloCore, enqueueMapsCore, enqueueShovelsCore, saveAgentSourcesCore, type SearchResult, type SearchRpc } from "@/lib/sources/search";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";

// Sender-only: the role is checked here (isSender in the cores) and again by the database. The workspace id comes
// from the session, never from the form. Results are fixed codes.

async function context() {
  const supabase = await createClient();
  const ws = await getCurrentWorkspace();
  if (!supabase || !ws) return null;
  const rpc: SearchRpc = async (fn, args) => {
    const { error } = await supabase.rpc(fn, args);
    return { error: error ? { code: error.code, message: error.message } : null };
  };
  return { who: { ws: ws.id, role: ws.role }, rpc };
}

const done = (r: SearchResult): SearchResult => {
  if ("ok" in r) revalidatePath("/leads/buscar");
  return r;
};

const get = (form: FormData, k: string) => form.get(k);

export async function enqueueMaps(_prev: SearchResult | null, form: FormData): Promise<SearchResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  return done(await enqueueMapsCore(c.who, { terms: get(form, "terms"), location: get(form, "location"), max: get(form, "max"), label: get(form, "label") }, { rpc: c.rpc }));
}

export async function enqueueApollo(_prev: SearchResult | null, form: FormData): Promise<SearchResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  return done(await enqueueApolloCore(c.who, { locations: get(form, "locations"), naics: get(form, "naics"), pages: get(form, "pages"), label: get(form, "label") }, { rpc: c.rpc }));
}

export async function enqueueShovels(_prev: SearchResult | null, form: FormData): Promise<SearchResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  return done(await enqueueShovelsCore(c.who, { place: get(form, "place"), tag: get(form, "tag"), max: get(form, "max"), label: get(form, "label") }, { rpc: c.rpc }));
}

export async function saveAgentSources(_prev: SearchResult | null, form: FormData): Promise<SearchResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  const r = await saveAgentSourcesCore(
    c.who,
    {
      agent: get(form, "agent"),
      maps: form.get("hasMaps") === "1",
      apollo: form.get("hasApollo") === "1",
      mapsOn: form.get("mapsOn") === "on",
      mapsTerms: get(form, "mapsTerms"),
      mapsLocation: get(form, "mapsLocation"),
      mapsMax: get(form, "mapsMax"),
      apolloOn: form.get("apolloOn") === "on",
      apolloLocations: get(form, "apolloLocations"),
      apolloNaics: get(form, "apolloNaics"),
      apolloPages: get(form, "apolloPages"),
    },
    { rpc: c.rpc },
  );
  if ("ok" in r) revalidatePath("/agentes/[id]", "page");
  return r;
}
