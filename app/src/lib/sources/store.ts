import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { supabaseRpc, type RpcFn } from "@/lib/hunter/rpc";
import type { ImportRowIn } from "./types";

// The sources clock's view of the database: no user session, the public anon key plus the scheduler token (checked
// INSIDE the database). Every call is a token-gated source_* function (0013). Short codes only.

export type SourceCounts = { started: number; polled: number; imported: number; failed: number };

/** One run as source_next_work returns it. `ciphertext` is the sealed key: open it with openKey, keep it local. */
export type SourceRunRow = {
  id: string;
  workspace_id: string;
  provider: "apify" | "apollo" | "shovels";
  kind: "maps" | "apollo" | "contact" | "shovels";
  query: Record<string, unknown>;
  max_results: number;
  reserve_usd: number;
  external_run_id: string | null;
  dataset_id: string | null;
  started_at: string | null;
  label: string | null;
  ciphertext: string;
};

export interface SourceTickStore {
  beginTick(): Promise<{ tickId: string; busy: boolean }>;
  finishTick(tickId: string, counts: SourceCounts, error: string | null): Promise<void>;
  enqueueAgentRuns(tickId: string): Promise<number>;
  nextWork(tickId: string): Promise<{ start: SourceRunRow[]; poll: SourceRunRow[] }>;
  markStarted(tickId: string, runId: string, externalId: string, datasetId: string): Promise<void>;
  markFailed(tickId: string, runId: string, error: string, costUsd: number | null): Promise<void>;
  importRows(tickId: string, runId: string, rows: ImportRowIn[], found: number, dropped: number, costUsd: number | null): Promise<{ new: number; merged: number }>;
  /** A contact run's leads and the site each one's scraper starts from (source_run_leads). */
  contactLeads(tickId: string, runId: string): Promise<{ leadId: string; startUrl: string }[]>;
  /** Stores a finished contact run's e-mails and settles the run (source_add_contacts); returns how many were new. */
  addContacts(tickId: string, runId: string, rows: { leadId: string; value: string; url: string }[], found: number, costUsd: number | null): Promise<number>;
}

const isRow = (x: unknown): x is SourceRunRow =>
  !!x && typeof x === "object" && typeof (x as SourceRunRow).id === "string" && typeof (x as SourceRunRow).ciphertext === "string";
const rows = (x: unknown): SourceRunRow[] => (Array.isArray(x) ? x.filter(isRow) : []);

export function rpcSourceStore(rpc: RpcFn): SourceTickStore {
  return {
    async beginTick() {
      const r = (await rpc("source_begin_tick", {})) as { tick_id: string | null; busy: boolean } | null;
      if (!r || typeof r.busy !== "boolean") throw new Error("rpc_source_begin_tick");
      if (r.busy) return { tickId: "", busy: true };
      if (typeof r.tick_id !== "string") throw new Error("rpc_source_begin_tick");
      return { tickId: r.tick_id, busy: false };
    },
    async finishTick(tickId, counts, error) {
      await rpc("source_finish_tick", { p_tick: tickId, p_counts: counts, p_error: error });
    },
    async enqueueAgentRuns(tickId) {
      const n = await rpc("source_enqueue_agent_runs", { p_tick: tickId });
      return typeof n === "number" ? n : 0;
    },
    async nextWork(tickId) {
      const r = (await rpc("source_next_work", { p_tick: tickId })) as { start?: unknown; poll?: unknown } | null;
      return { start: rows(r?.start), poll: rows(r?.poll) };
    },
    async markStarted(tickId, runId, externalId, datasetId) {
      await rpc("source_mark_started", { p_tick: tickId, p_run: runId, p_external_id: externalId, p_dataset: datasetId });
    },
    async markFailed(tickId, runId, error, costUsd) {
      await rpc("source_mark_failed", { p_tick: tickId, p_run: runId, p_error: error, p_cost: costUsd });
    },
    async importRows(tickId, runId, list, found, dropped, costUsd) {
      const r = (await rpc("source_import", { p_tick: tickId, p_run: runId, p_rows: list, p_found: found, p_dropped: dropped, p_cost: costUsd })) as {
        new?: number;
        merged?: number;
      } | null;
      return { new: r?.new ?? 0, merged: r?.merged ?? 0 };
    },
    async contactLeads(tickId, runId) {
      const r = await rpc("source_contact_leads", { p_tick: tickId, p_run: runId });
      return (Array.isArray(r) ? r : []).flatMap((x) => {
        const o = x as { lead_id?: unknown; start_url?: unknown } | null;
        return o && typeof o.lead_id === "string" && typeof o.start_url === "string" ? [{ leadId: o.lead_id, startUrl: o.start_url }] : [];
      });
    },
    async addContacts(tickId, runId, list, found, costUsd) {
      const n = await rpc("source_add_contacts", {
        p_tick: tickId,
        p_run: runId,
        p_rows: list.map((x) => ({ lead_id: x.leadId, value: x.value, url: x.url })),
        p_found: found,
        p_cost: costUsd,
      });
      return typeof n === "number" ? n : 0;
    },
  };
}

export function createSourceTickStore(token: string): SourceTickStore | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-scheduler-token": token } },
  });
  return rpcSourceStore(supabaseRpc(db));
}
