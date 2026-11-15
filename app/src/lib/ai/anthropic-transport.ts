import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { BLOCKED_NETWORK_HOSTS } from "@/lib/blocked-network";
import { urlKey } from "@/lib/safe-url";
import { AiTransportFailure } from "./errors";
import { supportsServerFallback } from "./models";
import { ZERO_USAGE, type AiRequest, type AiResponse, type AiStop, type AiTransport, type AiUsage } from "./types";

/** Never read or cite these (rule R11). Applied to both web tools. */
export const BLOCKED_DOMAINS = [...BLOCKED_NETWORK_HOSTS];

/** Page text kept per fetch (finding 2: lowered from 20k so the worst case of a call stays sane). */
export const WEB_FETCH_MAX_CONTENT_TOKENS = 8_000;
/** One deadline for the whole call, continuations included; the step route allows 300 s (finding 4). */
export const DEFAULT_DEADLINE_MS = 240_000;
/** pause_turn continuations: default 1, never more than 2 (finding 2). */
export const DEFAULT_MAX_CONTINUATIONS = 1;
export const MAX_CONTINUATIONS_CEILING = 2;

type Msg = Anthropic.Beta.Messages.BetaMessage;
type MsgParam = Anthropic.Beta.Messages.BetaMessageParam;
type StreamBody = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type MsgContent = Exclude<MsgParam["content"], undefined>;

/** The part of the SDK client this transport uses (tests inject a fake with the same shape; no network). */
export type StreamClient = {
  beta: {
    messages: {
      stream(body: Omit<StreamBody, "stream">, options?: { signal?: AbortSignal }): { finalMessage(): Promise<Msg>; currentMessage?: Msg | undefined };
    };
  };
};

export function addUsage(acc: AiUsage, m: Pick<Msg, "usage">): AiUsage {
  const u = m.usage;
  if (!u) return acc;
  return {
    inputTokens: acc.inputTokens + (u.input_tokens ?? 0),
    outputTokens: acc.outputTokens + (u.output_tokens ?? 0),
    cacheReadTokens: acc.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: acc.cacheWriteTokens + (u.cache_creation_input_tokens ?? 0),
    webSearches: acc.webSearches + (u.server_tool_use?.web_search_requests ?? 0),
    webFetches: acc.webFetches + (u.server_tool_use?.web_fetch_requests ?? 0),
  };
}

/** The answer is the text written after the last tool block (structured output puts the JSON there). */
function finalText(m: Msg): string {
  const parts: string[] = [];
  for (const block of m.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type !== "thinking" && block.type !== "redacted_thinking") parts.length = 0;
  }
  return parts.join("").trim();
}

export function mapStop(s: Msg["stop_reason"]): AiStop {
  switch (s) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
      return s;
    case "model_context_window_exceeded":
      return "max_tokens";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------- what the web tools actually returned (finding 3)
// With web_fetch_20260209 a fetch can run inside the dynamic-filtering code execution: the result still arrives as a
// top-level web_fetch_tool_result block (with a `caller`), and its JSON is echoed in the code execution stdout.
// Both placements are read; inside stdout only the unescaped `"type": "web_fetch_result", "url": ...` shape counts,
// so a URL merely printed from a page's text is not taken as fetched.
const FETCH_IN_STDOUT = /(?<!\\)"type":\s*"web_fetch_result",\s*"url":\s*"([^"\\]+)"(?:,\s*"retrieved_at":\s*"([^"\\]*)")?/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\‹›)\]}]+/g;

export class SeenUrls {
  readonly all = new Set<string>();
  readonly fetched = new Set<string>();
  /** web_fetch calls the model made, whatever the result (a refused fetch returns an error block without the URL). */
  readonly tried = new Set<string>();
  readonly at: Record<string, string> = {};
  /** Error codes returned by the web tools (a search error is an object in place of the result list), counted. */
  readonly errors: Record<string, number> = {};
  /** Search queries the model ran, in order (direct calls and calls made from code). */
  readonly queries: string[] = [];

  add(raw: unknown, via: "search" | "fetch" | "input", retrievedAt?: string | null) {
    if (typeof raw !== "string") return;
    const k = urlKey(raw);
    if (!k) return;
    this.all.add(k);
    if (via === "fetch") {
      this.fetched.add(k);
      if (retrievedAt && !Number.isNaN(Date.parse(retrievedAt))) this.at[k] = new Date(retrievedAt).toISOString();
    }
  }

  addFromText(text: string) {
    for (const m of text.matchAll(URL_IN_TEXT)) this.add(m[0].replace(/[.,;:]+$/, ""), "input");
  }

  private error(code: unknown) {
    const c = typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "unknown";
    this.errors[c] = (this.errors[c] ?? 0) + 1;
  }

  addFromContent(content: readonly unknown[] | undefined) {
    for (const raw of content ?? []) {
      const b = raw as { type?: string; content?: unknown; name?: string; input?: { url?: unknown; query?: unknown } };
      if (b.type === "server_tool_use" && b.name === "web_fetch") {
        const k = typeof b.input?.url === "string" ? urlKey(b.input.url) : null;
        if (k) this.tried.add(k);
      } else if (b.type === "server_tool_use" && b.name === "web_search") {
        if (typeof b.input?.query === "string" && this.queries.length < 50) this.queries.push(b.input.query.slice(0, 200));
      } else if (b.type === "web_search_tool_result") {
        if (Array.isArray(b.content)) {
          for (const r of b.content as { type?: string; url?: string }[]) if (r.type === "web_search_result") this.add(r.url, "search");
        } else this.error((b.content as { error_code?: unknown } | undefined)?.error_code);
      } else if (b.type === "web_fetch_tool_result") {
        const c = b.content as { type?: string; url?: string; retrieved_at?: string | null; error_code?: unknown } | undefined;
        if (c?.type === "web_fetch_result") this.add(c.url, "fetch", c.retrieved_at);
        else this.error(c?.error_code);
      } else if (b.type === "code_execution_tool_result" || b.type === "bash_code_execution_tool_result") {
        const stdout = (b.content as { stdout?: unknown } | undefined)?.stdout;
        if (typeof stdout === "string") for (const m of stdout.matchAll(FETCH_IN_STDOUT)) this.add(m[1], "fetch", m[2]);
      }
    }
  }
}

// ---------------------------------------------------------------- continuation helpers (finding 14)
const CACHEABLE = new Set(["text", "server_tool_use", "web_search_tool_result", "web_fetch_tool_result", "code_execution_tool_result", "bash_code_execution_tool_result"]);

/** The paused assistant turn, sent back unchanged except for one cache breakpoint on its last cacheable block. */
export function withCacheBreakpoint(content: Msg["content"]): MsgContent {
  const blocks = content.map((b) => ({ ...b })) as Record<string, unknown>[];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].type as string;
    if (t === "thinking" || t === "redacted_thinking") continue;
    if (CACHEABLE.has(t)) blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral" } };
    break;
  }
  return blocks as unknown as MsgContent;
}

/**
 * The web tools of a call. The SAME definitions are sent on every request of the call, continuations included:
 * changing a tool mid-turn (for example lowering max_uses) is an edit to the request prefix that invalidates the
 * paused turn's thinking blocks. The reserve (pricing.worstCaseUsd) therefore counts max_uses once per request.
 *
 * Search is the basic web_search_20250305 (no code-execution wrapper): in the live diagnosis of 10/11/2026 the dynamic-filtering version
 * (web_search_20260209) spent 3 of its 4 max_uses on direct calls the model wrapped in {"params": {...}}
 * (invalid_tool_input), then answered max_uses_exceeded, and the model returned sources without links; the measured
 * cost per search of the two versions is the same (docs/mvp/fase-1-3-pesquisa.md, finding 19).
 */
export function toolsFor(req: AiRequest): Anthropic.Beta.Messages.BetaToolUnion[] {
  const tools: Anthropic.Beta.Messages.BetaToolUnion[] = [];
  if (req.web?.search) {
    tools.push({ type: "web_search_20250305", name: "web_search", max_uses: req.web.search.maxUses, blocked_domains: BLOCKED_DOMAINS });
  }
  if (req.web?.fetch) {
    // Basic fetch (no dynamic-filtering code wrapper): measured cheaper per page in docs/mvp/fase-1-3-pesquisa.md (finding 19).
    tools.push({
      type: "web_fetch_20250910",
      name: "web_fetch",
      max_uses: req.web.fetch.maxUses,
      blocked_domains: BLOCKED_DOMAINS,
      max_content_tokens: req.web.fetch.maxContentTokens ?? WEB_FETCH_MAX_CONTENT_TOKENS,
    });
  }
  return tools;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300);
  return "unknown error";
}

/**
 * Real transport (official SDK). Streams every request, adaptive thinking, structured output through
 * output_config.format, server-side refusal fallback where the model supports it, the blocked network excluded from both web tools,
 * pause_turn resumed (at most MAX_CONTINUATIONS_CEILING times) with a cache breakpoint and the same tools,
 * no SDK retries, one deadline for the whole call, and the URLs the web tools really returned (seenUrls).
 */
export class AnthropicTransport implements AiTransport {
  private readonly client: StreamClient;

  constructor(apiKeyOrClient: string | StreamClient) {
    // maxRetries 0: a retry inside the SDK could outlive the route's limit and would be spend nobody records.
    this.client = typeof apiKeyOrClient === "string" ? (new Anthropic({ apiKey: apiKeyOrClient, maxRetries: 0 }) as unknown as StreamClient) : apiKeyOrClient;
  }

  async send(req: AiRequest): Promise<AiResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.deadlineMs ?? DEFAULT_DEADLINE_MS);
    try {
      try {
        return await this.run(req, true, ctl.signal);
      } catch (e) {
        // If the API refuses structured output together with the web tools, retry once with the schema in the
        // prompt; the gateway validates with zod anyway. (The 10/11 live run did not need it.)
        const cause = e instanceof AiTransportFailure ? e.original : e;
        if (cause instanceof Anthropic.BadRequestError && req.web && /citation|output_config|format/i.test(cause.message) && !ctl.signal.aborted) {
          const before = e instanceof AiTransportFailure ? e.usage : ZERO_USAGE;
          const retry = await this.run(req, false, ctl.signal).catch((e2: unknown) => {
            throw e2 instanceof AiTransportFailure ? new AiTransportFailure(e2.message, sumUsage(before, e2.usage), e2.timedOut, e2.original) : e2;
          });
          return { ...retry, usage: sumUsage(before, retry.usage) };
        }
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(req: AiRequest, structured: boolean, signal: AbortSignal): Promise<AiResponse> {
    const system = structured
      ? req.system
      : `${req.system}\n\nReply with only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(req.jsonSchema)}`;
    const fallback = supportsServerFallback(req.model);
    const maxContinuations = Math.max(0, Math.min(req.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS, MAX_CONTINUATIONS_CEILING));

    const seen = new SeenUrls();
    seen.addFromText(req.user); // web fetch may open URLs that were already in the conversation
    const turns: Msg["content"][] = [];
    let usage = ZERO_USAGE;
    let last: Msg | null = null;

    const tools = toolsFor(req);
    for (let i = 0; i <= maxContinuations; i++) {
      const messages: MsgParam[] = [{ role: "user", content: req.user }];
      turns.forEach((content, n) =>
        messages.push({ role: "assistant", content: n === turns.length - 1 ? withCacheBreakpoint(content) : (content as unknown as MsgContent) }),
      );
      if (signal.aborted) throw new AiTransportFailure("deadline reached", usage, true);
      const stream = this.client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // Stable system prompt first, cached (prompt caching is a prefix match).
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages,
          ...(tools.length ? { tools } : {}),
          thinking: { type: "adaptive" },
          output_config: {
            effort: req.effort,
            ...(structured ? { format: { type: "json_schema" as const, schema: req.jsonSchema } } : {}),
          },
          ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        } as Omit<StreamBody, "stream">,
        { signal },
      );
      try {
        last = await stream.finalMessage();
      } catch (e) {
        // Billed tokens of the interrupted request (message_start / message_delta) still count.
        const partial = stream.currentMessage;
        if (partial) seen.addFromContent(partial.content);
        throw new AiTransportFailure(signal.aborted ? "deadline reached" : errorText(e), partial ? addUsage(usage, partial) : usage, signal.aborted, e);
      }
      usage = addUsage(usage, last);
      seen.addFromContent(last.content);
      if (last.stop_reason !== "pause_turn") break;
      turns.push(last.content);
    }

    const seenOut = {
      seenUrls: [...seen.all],
      fetchedUrls: [...seen.fetched],
      triedUrls: [...seen.tried],
      seenAt: seen.at,
      toolErrors: seen.errors,
      searchQueries: seen.queries,
    };
    if (!last) return { stop: "pause_turn", text: "", usage, ...seenOut };
    return {
      stop: mapStop(last.stop_reason),
      text: last.stop_reason === "refusal" ? "" : finalText(last),
      usage,
      refusalCategory: last.stop_reason === "refusal" ? (last.stop_details?.category ?? null) : null,
      ...seenOut,
    };
  }
}

function sumUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    webSearches: a.webSearches + b.webSearches,
    webFetches: a.webFetches + b.webFetches,
  };
}
