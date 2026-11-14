import "server-only";
import { MODELS, type ModelId } from "./models";
import type { AiUsage } from "./types";

// US$ per million tokens. Source: platform.claude.com/docs/en/about-claude/pricing, read on 10/11/2026
// (input/output also in docs/mvp-harness.md 11.5). Cache writes are the 5-minute TTL price (the only TTL we use).
// Claude Haiku 5.5 has a higher tier for prompts over 100,000 tokens; our prompts stay far below it, but the
// higher tier is applied if a call ever crosses it.
type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };

export const PRICES: Record<ModelId, Price> = {
  [MODELS.opus]: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  [MODELS.sonnet]: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  [MODELS.haiku]: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };

/** Web search: US$ 10 per 1,000 searches (same page). Web fetch: no charge beyond tokens (same page). */
export const WEB_SEARCH_USD = 0.01;
export const WEB_FETCH_USD = 0;

/**
 * Estimated cost of one call, at the requested model's list price. Not verified against a real invoice: a refusal
 * that the server re-ran on a fallback model is billed at the fallback's price, which may differ slightly.
 */
export function estimateCostUsd(model: ModelId, u: AiUsage): number {
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const p = model === MODELS.haiku && promptTokens > 100_000 ? HAIKU_LONG : PRICES[model];
  const tokens =
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead) /
    1_000_000;
  const tools = u.webSearches * WEB_SEARCH_USD + u.webFetches * WEB_FETCH_USD;
  return Math.round((tokens + tools) * 1_000_000) / 1_000_000;
}

/**
 * Inputs of the worst-case estimate (finding 2). Base input = system prompt + user message allowance. A web search
 * result block was measured at about 20k input tokens per search on 10/11/2026 (docs/mvp/fase-1-3-pesquisa.md).
 */
export const WORST_CASE = { baseInputTokens: 8_000, searchResultTokens: 20_000, fetchContentTokens: 8_000 } as const;

/**
 * Money reserved before a call: requests x [max output tokens x output price + (base input + fetch max_uses x page
 * tokens + search max_uses x search-result tokens) x input price + search max_uses x US$ 0.01], where requests =
 * 1 + pause_turn continuations (only calls with web tools can pause). Every request of a call carries the same tool
 * definitions (changing them mid-turn would break the turn's thinking blocks), so each request may use max_uses
 * again and is counted in full. A heuristic ceiling, not a guarantee: inside one request the server-side tool loop
 * re-reads its context (at the cache-read price). The settled cost is the real one; live calls cost 5 to 15 times
 * less than their reserve (docs/mvp/fase-1-3-pesquisa.md).
 */
export function worstCaseUsd(
  model: ModelId,
  maxTokens: number,
  web?: { search?: { maxUses: number }; fetch?: { maxUses: number; maxContentTokens?: number } },
  continuations = 1,
): number {
  const searches = web?.search?.maxUses ?? 0;
  const fetches = web?.fetch?.maxUses ?? 0;
  const requests = 1 + (searches || fetches ? Math.max(0, continuations) : 0);
  const input =
    WORST_CASE.baseInputTokens + fetches * (web?.fetch?.maxContentTokens ?? WORST_CASE.fetchContentTokens) + searches * WORST_CASE.searchResultTokens;
  const p = model === MODELS.haiku && input > 100_000 ? HAIKU_LONG : PRICES[model];
  const usd = requests * ((input * p.input + maxTokens * p.output) / 1_000_000 + searches * WEB_SEARCH_USD);
  return Math.ceil(usd * 100) / 100;
}
