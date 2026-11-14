"use server";

import { revalidatePath } from "next/cache";
import { deleteKeyCore, saveCapCore, saveKeyCore, type Rpc, type SourceResult } from "@/lib/sources/connections";
import { fetchHttpJson } from "@/lib/sources/http";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";

// Owner only (the database checks again). The workspace id comes from the session, never from the form.
// Results are fixed codes: no key, no service message, ever.

const PAGE = "/configuracoes/fontes";

async function context() {
  const supabase = await createClient();
  const ws = await getCurrentWorkspace();
  if (!supabase || !ws) return null;
  const rpc: Rpc = async (fn, args) => {
    const { error } = await supabase.rpc(fn, args);
    return { error: error ? { code: error.code } : null };
  };
  return { who: { ws: ws.id, role: ws.role }, rpc };
}

const done = (r: SourceResult): SourceResult => {
  if ("ok" in r) revalidatePath(PAGE);
  return r;
};

export async function saveSourceKey(_prev: SourceResult | null, form: FormData): Promise<SourceResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  return done(await saveKeyCore(c.who, { provider: form.get("provider"), key: form.get("key"), cap: form.get("cap") }, { http: fetchHttpJson, rpc: c.rpc }));
}

export async function saveSourceCap(_prev: SourceResult | null, form: FormData): Promise<SourceResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  return done(await saveCapCore(c.who, { provider: form.get("provider"), cap: form.get("cap") }, { rpc: c.rpc }));
}

export async function deleteSourceKey(provider: string): Promise<SourceResult> {
  const c = await context();
  if (!c) return { error: "generic" };
  return done(await deleteKeyCore(c.who, { provider }, { rpc: c.rpc }));
}
