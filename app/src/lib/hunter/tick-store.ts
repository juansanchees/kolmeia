import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { ResearchStore } from "@/lib/research/store";
import { HunterResearchStore } from "./research-store";
import { supabaseRpc, type RpcFn } from "./rpc";

// The Caçador clock's view of the database: no user session, the public anon key plus the scheduler token (header
// x-scheduler-token, checked INSIDE the database). Everything is a token-gated hunter_* function. Short codes only (R10).

export type HunterPauseReason = "daily_cap" | "user_cap" | "global_cap" | "no_access";
export type HunterCounts = { runs: number; steps: number; paused: number; failed: number };

export interface HunterTickStore {
  beginTick(): Promise<{ tickId: string; busy: boolean }>;
  dueWork(tickId: string): Promise<string[]>;
  pauseAgent(tickId: string, runId: string, reason: HunterPauseReason): Promise<void>;
  finishTick(tickId: string, counts: HunterCounts, error: string | null): Promise<void>;
  research(tickId: string): ResearchStore;
}

export class RpcHunterTickStore implements HunterTickStore {
  constructor(private readonly rpc: RpcFn) {}

  async beginTick(): Promise<{ tickId: string; busy: boolean }> {
    const r = (await this.rpc("hunter_begin_tick", {})) as { tick_id: string | null; busy: boolean } | null;
    if (!r || typeof r.busy !== "boolean") throw new Error("rpc_hunter_begin_tick");
    if (r.busy) return { tickId: "", busy: true };
    if (typeof r.tick_id !== "string") throw new Error("rpc_hunter_begin_tick");
    return { tickId: r.tick_id, busy: false };
  }

  async dueWork(tickId: string): Promise<string[]> {
    const r = (await this.rpc("hunter_due_work", { p_tick: tickId })) as { run_ids?: unknown } | null;
    return Array.isArray(r?.run_ids) ? (r.run_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  }

  async pauseAgent(tickId: string, runId: string, reason: HunterPauseReason): Promise<void> {
    await this.rpc("hunter_pause_agent", { p_tick: tickId, p_run: runId, p_reason: reason });
  }

  async finishTick(tickId: string, counts: HunterCounts, error: string | null): Promise<void> {
    await this.rpc("hunter_finish_tick", { p_tick: tickId, p_counts: counts, p_error: error });
  }

  research(tickId: string): ResearchStore {
    return new HunterResearchStore(this.rpc, tickId);
  }
}

export function createHunterTickStore(token: string): HunterTickStore | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const db: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-scheduler-token": token } },
  });
  return new RpcHunterTickStore(supabaseRpc(db));
}
