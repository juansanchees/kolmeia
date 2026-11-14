import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiCapErrorFrom } from "./errors";
import type { AiCallRecord, AiReservation } from "./gateway";

/**
 * The only way the app writes the AI ledger (migration 0004 revokes direct INSERT on ai_calls).
 * Shared by every area's store (research and e-mail) so the cap and allowlist rules live in one place.
 */
export async function reserveAiCallRpc(db: SupabaseClient, r: AiReservation): Promise<string> {
  const { data, error } = await db.rpc("reserve_ai_call", {
    p_workspace: r.workspaceId,
    p_run: r.runId,
    p_task: r.task,
    p_model: r.model,
    p_prompt_version: r.promptVersion,
    p_reserve_usd: r.reserveUsd,
    p_user_cap_usd: r.userDailyCapUsd,
    p_global_cap_usd: r.globalDailyCapUsd,
  });
  if (error) {
    const typed = aiCapErrorFrom(error.message);
    if (typed) throw typed;
    // Never include row data in the error (R10).
    throw new Error(`reserveAiCall: ${error.message}`);
  }
  return data as string;
}

export async function settleAiCallRpc(db: SupabaseClient, id: string, row: AiCallRecord): Promise<void> {
  const { error } = await db.rpc("settle_ai_call", {
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
  if (error) throw new Error(`settleAiCall: ${error.message}`);
}
