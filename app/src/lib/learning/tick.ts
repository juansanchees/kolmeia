import "server-only";
import type { AiLedger } from "@/lib/ai/gateway";
import { learnFromResults } from "@/lib/ai/results-tasks";
import type { AiTransport } from "@/lib/ai/types";
import type { RpcFn } from "@/lib/hunter/rpc";
import { currentProfileOf, learnedSomething, resultsDue, type ResultsData } from "./results";

/**
 * The clock's side of the learning loop: at most ONE workspace per call, at most one AI call. Picks the first workspace
 * hunter_results_due offers whose rows pass resultsDue, then proposes (nothing applies without a sender's approval).
 * Throws on any failure; the hunter tick swallows it.
 */
export async function learnFromResultsTick(rpc: RpcFn, tickId: string, transport: AiTransport | null, now = Date.now()): Promise<"none" | "empty" | "proposed"> {
  if (!transport) return "none";
  const due = (await rpc("hunter_results_due", { p_tick: tickId })) as { workspace_id: string }[] | null;
  for (const w of due ?? []) {
    const d = (await rpc("hunter_results_rows", { p_tick: tickId, p_ws: w.workspace_id })) as ResultsData;
    if (!resultsDue({ lastAt: d.last_at, now, rows: d.rows })) continue;
    const no = async (): Promise<never> => {
      throw new Error("use_reserve");
    };
    const ledger: AiLedger = {
      reserve: async (r) =>
        (await rpc("hunter_results_reserve_ai_call", {
          p_tick: tickId,
          p_ws: w.workspace_id,
          p_task: r.task,
          p_model: r.model,
          p_prompt_version: r.promptVersion,
          p_reserve_usd: r.reserveUsd,
          p_user_cap_usd: r.userDailyCapUsd,
          p_global_cap_usd: r.globalDailyCapUsd,
        })) as string,
      settle: async (id, row) => {
        await rpc("hunter_results_settle_ai_call", {
          p_tick: tickId,
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
      record: no,
      dailyCapUsd: no,
      spentTodayUsd: no,
    };
    const current = currentProfileOf(d.current);
    const r = await learnFromResults({ workspaceId: w.workspace_id, runId: null, ledger, transport }, d.rows, current);
    // nothing the results back: no proposal; the call itself (ai_calls) starts the 7 days (results_last_at)
    if (!learnedSomething(r.data, current)) return "empty";
    await rpc("hunter_propose_results_profile", { p_tick: tickId, p_ws: w.workspace_id, p_profile: r.data, p_sample_rows: r.sampleRows });
    return "proposed";
  }
  return "none";
}
