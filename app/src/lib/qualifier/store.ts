import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AiCallRecord, AiLedger, AiReservation } from "@/lib/ai/gateway";
import { aiSpendCaps } from "@/lib/ai/config";
import { aiCapErrorFrom } from "@/lib/ai/errors";
import { env } from "@/lib/env";
import { supabaseRpc, type RpcFn } from "@/lib/hunter/rpc";
import {
  normalizeSnapshot,
  type DoneReason,
  type FieldIn,
  type LeadSnapshot,
  type QualifierCounts,
  type QualifierPauseReason,
  type QualifierStep,
  type StepOutcome,
} from "./types";

// The Qualificador clock's view of the database: no user session, the public anon key plus the scheduler token
// (checked INSIDE the database). Every call is a token-gated qualifier_* function (0014). Short codes only.

export interface QualifierTickStore {
  beginTick(): Promise<{ tickId: string; busy: boolean }>;
  finishTick(tickId: string, counts: QualifierCounts, error: string | null): Promise<void>;
  claimNext(tickId: string): Promise<LeadSnapshot | null>;
  merge(tickId: string, leadId: string): Promise<number>;
  addFields(tickId: string, leadId: string, rows: FieldIn[]): Promise<number>;
  refute(tickId: string, leadId: string, ids: string[]): Promise<void>;
  stepDone(tickId: string, leadId: string, step: QualifierStep, outcome: StepOutcome, next: QualifierStep | "done", doneReason: DoneReason | null): Promise<void>;
  /** P2b: put the lead in the workspace's open contact run. False = nothing asked (no Apify connection, over the day's cap, or answered lately). */
  requestContacts(tickId: string, leadId: string, url: string): Promise<boolean>;
  release(tickId: string, leadId: string): Promise<void>;
  /** The tick must hold a lead of the workspace: call it BEFORE release (it frees this tick's locks there). */
  pause(tickId: string, workspaceId: string, reason: QualifierPauseReason): Promise<void>;
  ledger(tickId: string, leadId: string): AiLedger;
  reservePlaces(tickId: string, leadId: string, usd: number): Promise<string>;
  settlePlaces(tickId: string, leadId: string, id: string, costUsd: number, ok: boolean): Promise<void>;
}

const NOT_ON_PATH = "not available on the Qualificador path";
const ZERO_SETTLE = { p_input_tokens: 0, p_output_tokens: 0, p_cache_read_tokens: 0, p_cache_write_tokens: 0, p_web_searches: 0, p_web_fetches: 0 };

export function rpcQualifierStore(rpc: RpcFn): QualifierTickStore {
  const reserveCall = async (tickId: string, leadId: string, r: { task: string; model: string; promptVersion: string; reserveUsd: number; userCap: number; globalCap: number }) => {
    try {
      return (await rpc("qualifier_reserve_ai_call", {
        p_tick: tickId,
        p_lead: leadId,
        p_task: r.task,
        p_model: r.model,
        p_prompt_version: r.promptVersion,
        p_reserve_usd: r.reserveUsd,
        p_user_cap_usd: r.userCap,
        p_global_cap_usd: r.globalCap,
      })) as string;
    } catch (e) {
      const typed = aiCapErrorFrom(e instanceof Error ? e.message : null);
      if (typed) throw typed;
      throw e;
    }
  };
  return {
    async beginTick() {
      const r = (await rpc("qualifier_begin_tick", {})) as { tick_id: string | null; busy: boolean } | null;
      if (!r || typeof r.busy !== "boolean") throw new Error("rpc_qualifier_begin_tick");
      if (r.busy) return { tickId: "", busy: true };
      if (typeof r.tick_id !== "string") throw new Error("rpc_qualifier_begin_tick");
      return { tickId: r.tick_id, busy: false };
    },
    async finishTick(tickId, counts, error) {
      await rpc("qualifier_finish_tick", { p_tick: tickId, p_counts: counts, p_error: error });
    },
    async claimNext(tickId) {
      const r = await rpc("qualifier_claim_next", { p_tick: tickId });
      return r ? normalizeSnapshot(r) : null;
    },
    async merge(tickId, leadId) {
      const n = await rpc("qualifier_merge", { p_tick: tickId, p_lead: leadId });
      return typeof n === "number" ? n : 0;
    },
    async addFields(tickId, leadId, rows) {
      if (!rows.length) return 0;
      const n = await rpc("qualifier_add_fields", { p_tick: tickId, p_lead: leadId, p_rows: rows });
      return typeof n === "number" ? n : 0;
    },
    async refute(tickId, leadId, ids) {
      if (!ids.length) return;
      await rpc("qualifier_refute", { p_tick: tickId, p_lead: leadId, p_field_ids: ids });
    },
    async stepDone(tickId, leadId, step, outcome, next, doneReason) {
      await rpc("qualifier_step_done", { p_tick: tickId, p_lead: leadId, p_step: step, p_outcome: outcome, p_next: next, p_done_reason: doneReason });
    },
    async requestContacts(tickId, leadId, url) {
      return (await rpc("qualifier_request_contacts", { p_tick: tickId, p_lead: leadId, p_url: url })) === true;
    },
    async release(tickId, leadId) {
      await rpc("qualifier_release", { p_tick: tickId, p_lead: leadId });
    },
    async pause(tickId, workspaceId, reason) {
      await rpc("qualifier_pause", { p_tick: tickId, p_ws: workspaceId, p_reason: reason });
    },
    ledger(tickId, leadId): AiLedger {
      return {
        dailyCapUsd: () => Promise.reject(new Error(NOT_ON_PATH)),
        spentTodayUsd: () => Promise.reject(new Error(NOT_ON_PATH)),
        record: (_row: AiCallRecord) => Promise.reject(new Error(NOT_ON_PATH)),
        reserve: (r: AiReservation) =>
          reserveCall(tickId, leadId, { task: r.task, model: r.model, promptVersion: r.promptVersion, reserveUsd: r.reserveUsd, userCap: r.userDailyCapUsd, globalCap: r.globalDailyCapUsd }),
        settle: async (id: string, row: AiCallRecord) => {
          await rpc("qualifier_settle_ai_call", {
            p_tick: tickId,
            p_lead: leadId,
            p_id: id,
            p_status: row.status,
            p_input_tokens: row.usage.inputTokens,
            p_output_tokens: row.usage.outputTokens,
            p_cache_read_tokens: row.usage.cacheReadTokens,
            p_cache_write_tokens: row.usage.cacheWriteTokens,
            p_web_searches: row.usage.webSearches,
            p_web_fetches: row.usage.webFetches,
            p_cost_usd: row.costUsd,
            p_error: row.error,
            p_duration_ms: row.durationMs,
          });
        },
      };
    },
    async reservePlaces(tickId, leadId, usd) {
      const caps = aiSpendCaps();
      return reserveCall(tickId, leadId, { task: "qualify_places", model: "google-places", promptVersion: "places-1", reserveUsd: usd, userCap: caps.userDailyUsd, globalCap: caps.globalDailyUsd });
    },
    async settlePlaces(tickId, leadId, id, costUsd, ok) {
      await rpc("qualifier_settle_ai_call", {
        p_tick: tickId,
        p_lead: leadId,
        p_id: id,
        p_status: ok ? "ok" : "error",
        ...ZERO_SETTLE,
        p_cost_usd: costUsd,
        p_error: ok ? null : "places_error",
        p_duration_ms: 0,
      });
    },
  };
}

export function createQualifierTickStore(token: string): QualifierTickStore | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-scheduler-token": token } },
  });
  return rpcQualifierStore(supabaseRpc(db));
}
