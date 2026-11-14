import "server-only";
import type { ModelId } from "./models";

export type AiTask =
  | "research_questions"
  | "research_plan"
  | "research_discover"
  | "research_collect"
  | "research_verify"
  | "research_second_pass"
  | "classify"
  | "email_draft"
  | "email_classify"
  | "email_reply_draft"
  | "email_closer_brief";

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  webFetches: number;
};

export const ZERO_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
  webFetches: 0,
};

/** Read-only web tools (server tools run by Anthropic). There is no tool that writes, sends or deletes (R13). */
export type WebTools = {
  search?: { maxUses: number };
  /** maxContentTokens defaults to WEB_FETCH_MAX_CONTENT_TOKENS (8k) in the transport. */
  fetch?: { maxUses: number; maxContentTokens?: number };
};

export type AiRequest = {
  task: AiTask;
  model: ModelId;
  system: string;
  user: string;
  /** JSON Schema for structured output (output_config.format). */
  jsonSchema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
  maxTokens: number;
  web?: WebTools;
  /**
   * pause_turn continuations allowed (default 1). Each one is a full extra request with the SAME tool definitions
   * (changing tools mid-turn would invalidate the turn's thinking blocks), so each may use up to max_uses again.
   */
  maxContinuations?: number;
  /** One overall deadline for the whole call, continuations included (default 240 s). */
  deadlineMs?: number;
};

export type AiStop = "end_turn" | "max_tokens" | "refusal" | "pause_turn" | "other";

export type AiResponse = {
  stop: AiStop;
  /** The final text (the JSON answer). */
  text: string;
  usage: AiUsage;
  refusalCategory?: string | null;
  /**
   * Every URL the web tools actually returned in this call (search results and fetched pages) plus the URLs that
   * were already in the request. Evidence citing anything else is dropped (finding 3). Undefined = the transport
   * does not report it; then a call with web tools is treated as having seen nothing.
   */
  seenUrls?: string[];
  /** The subset of seenUrls that was opened with web fetch (not only listed by a search). */
  fetchedUrls?: string[];
  /** URLs the model asked web fetch to open (success or not), normalised with urlKey(). */
  triedUrls?: string[];
  /** Retrieval time of fetched pages, by urlKey(). */
  seenAt?: Record<string, string>;
  /**
   * Error codes the web tools returned in this call, counted (for example max_uses_exceeded: the call's own
   * max_uses was reached, a normal end of searching; invalid_tool_input: a malformed tool call). Never a failure.
   */
  toolErrors?: Record<string, number>;
  /** The searches the model ran in this call (query text), in order. */
  searchQueries?: string[];
};

/** Everything that talks to the network implements this; tests inject a fake (no test calls the network). */
export interface AiTransport {
  send(req: AiRequest): Promise<AiResponse>;
}
