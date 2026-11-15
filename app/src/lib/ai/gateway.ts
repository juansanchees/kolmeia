import "server-only";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { hostOf, urlKey } from "@/lib/safe-url";
import { AnthropicTransport, DEFAULT_MAX_CONTINUATIONS } from "./anthropic-transport";
import { aiSpendCaps, getAnthropicKey } from "./config";
import { AiError, AiTransportFailure } from "./errors";
import type { ModelId } from "./models";
import { estimateCostUsd, worstCaseUsd } from "./pricing";
import { budgetLine } from "./prompts/shared";
import { fitWebToBudget } from "./routing";
import { ZERO_USAGE, type AiRequest, type AiResponse, type AiTask, type AiTransport, type AiUsage, type WebTools } from "./types";

// The one door every AI call goes through: access allowlist and caps (R16, P6), the ledger (R17), output
// validation (R15), and the check that cited URLs were really returned by the web tools (finding 3).

export type AiCallStatus = "ok" | "refused" | "invalid_output" | "truncated" | "error";

export type AiCallRecord = {
  workspaceId: string;
  runId: string | null;
  task: AiTask;
  model: ModelId;
  promptVersion: string;
  usage: AiUsage;
  costUsd: number;
  status: AiCallStatus;
  error: string | null;
  durationMs: number;
};

/** What is reserved before a call (one ledger row, status "pending", counted at reserveUsd until settled). */
export type AiReservation = {
  workspaceId: string;
  runId: string | null;
  task: AiTask;
  model: ModelId;
  promptVersion: string;
  reserveUsd: number;
  /** Server-only env caps; the database clamps them to public.ai_limits (env can only lower them). */
  userDailyCapUsd: number;
  globalDailyCapUsd: number;
};

/**
 * Where calls are recorded (the logged-in user's session; RLS applies).
 * Preferred: `reserve` + `settle` (one atomic check-and-reserve in the database: access allowlist, run cap,
 * workspace / user / global daily caps; then the row is settled once with the real usage). Ledgers without them
 * fall back to the old check-then-`record` path (kept for backward compatibility; the hosted database no longer
 * grants direct inserts into ai_calls after migration 0004, so production must use reserve/settle).
 */
export interface AiLedger {
  dailyCapUsd(workspaceId: string): Promise<number>;
  spentTodayUsd(workspaceId: string): Promise<number>;
  record(row: AiCallRecord): Promise<void>;
  /** Returns the ledger row id. Throws AiError (no_access, daily_cap, user_cap, global_cap, run_cap, run_time). */
  reserve?(r: AiReservation): Promise<string>;
  settle?(id: string, row: AiCallRecord): Promise<void>;
}

export type AiContext = {
  workspaceId: string;
  runId: string | null;
  ledger: AiLedger;
  transport: AiTransport | null;
  /** Remaining budget of the run (P6). */
  runBudget?: { spentUsd: number; maxUsd: number };
  /** Time this one call may take, in ms, from now (the caller's request deadline minus the clock); the transport aborts there. */
  deadlineMs?: number;
};

/** What normalize may use to check the model's URLs against the web tools' real results (optional for old tasks). */
export type TaskMeta = {
  /** True when the URL was returned by a web tool in this call (or was in the request). Always false for unsafe URLs. */
  seen(url: string | null | undefined): boolean;
  /** True when the URL was opened with web fetch (not only listed in a search). */
  fetched(url: string | null | undefined): boolean;
  /** True when the model asked web fetch to open the URL, whether or not it loaded (a "blocked" claim needs this). */
  tried(url: string | null | undefined): boolean;
  /** Retrieval time of a fetched page (ISO), when the tool reported it. */
  seenAt(url: string | null | undefined): string | undefined;
  /** True when a web tool returned at least one page on this URL's site (host without "www."). */
  seenHost?(url: string | null | undefined): boolean;
  /** Count of cited URLs dropped because no web tool returned them. normalize increments it. */
  dropped: { count: number };
};

export type TaskDef<Input, Parsed, Out> = {
  task: AiTask;
  model: ModelId;
  promptVersion: string;
  system: string;
  /** A schema, or one built per input (for example an enum of the refs that must come back). */
  schema: z.ZodType<Parsed> | ((input: Input) => z.ZodType<Parsed>);
  effort: AiRequest["effort"];
  maxTokens: number;
  web?: WebTools;
  /** pause_turn continuations (default 1, max 2). */
  maxContinuations?: number;
  /**
   * Optional floor for the reservation. The gateway always reserves at least the worst case computed from
   * model, maxTokens, web limits and continuations (pricing.worstCaseUsd).
   */
  reserveUsd?: number;
  /** The request text. For a task with web tools the gateway appends the call's web budget line (budgetLine). */
  buildUser: (input: Input) => string;
  /** Turns the validated model output into what our code stores (caps, URL checks, defaults). */
  normalize: (parsed: Parsed, input: Input, meta: TaskMeta) => Out;
};

/** What the web tools did in one call (for honest limit notes and for not repeating searches). */
export type WebReport = {
  searches: number;
  fetches: number;
  queries: string[];
  /** Tool error codes, counted (max_uses_exceeded, invalid_tool_input, url_not_accessible...). */
  errors: Record<string, number>;
  /** The call reached its own per-call web budget (max_uses) for search or fetch. */
  budgetUsed: boolean;
  /** The web budget this call was actually given (smaller than the task's when the run's cost cap was close). */
  limits: WebTools;
  /** True when the web budget was shrunk to fit the run's remaining cost cap. */
  trimmed: boolean;
};

export type TaskResult<Out> = { data: Out; costUsd: number; usage: AiUsage; droppedUrls?: number; web?: WebReport };

export const DEFAULT_DAILY_CAP_USD = 10;

/** The real transport, or null when no key is configured ("IA não configurada"). */
export function defaultTransport(): AiTransport | null {
  const key = getAnthropicKey();
  return key ? new AnthropicTransport(key) : null;
}

/** Pulls the JSON object out of the model text (structured output returns bare JSON; tolerate fences). */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object");
  return JSON.parse(s.slice(start, end + 1));
}

const schemaCache = new WeakMap<object, Record<string, unknown>>();

/** JSON Schema for output_config.format, built by the SDK helper (it drops constraints the API does not accept). */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(schema);
  if (!s) {
    s = betaZodOutputFormat(schema as never).schema as Record<string, unknown>;
    schemaCache.set(schema, s);
  }
  return s;
}

/** The reservation for a task: its own floor or the computed worst case, whichever is higher. */
export function reserveFor<I, P, O>(def: TaskDef<I, P, O>): number {
  const worst = worstCaseUsd(def.model, def.maxTokens, def.web, def.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS);
  return Math.max(def.reserveUsd ?? 0, worst);
}

/** Builds the URL checks for normalize from what the transport reported. */
export function taskMeta(res: Pick<AiResponse, "seenUrls" | "fetchedUrls" | "triedUrls" | "seenAt">, usesWeb: boolean): TaskMeta {
  const seen = new Set(res.seenUrls ?? []);
  const hosts = new Set([...seen].map((u) => hostOf(u)).filter(Boolean));
  const fetched = new Set(res.fetchedUrls ?? []);
  const tried = new Set([...(res.triedUrls ?? []), ...fetched]);
  const at = res.seenAt ?? {};
  const key = (u: string | null | undefined) => (u ? urlKey(u) : null);
  return {
    // A task without web tools has no tool results to check against; its normalize must not keep URLs anyway.
    seen: (u) => {
      const k = key(u);
      return Boolean(k) && (!usesWeb || seen.has(k!));
    },
    fetched: (u) => {
      const k = key(u);
      return Boolean(k) && fetched.has(k!);
    },
    tried: (u) => {
      const k = key(u);
      return Boolean(k) && tried.has(k!);
    },
    seenAt: (u) => {
      const k = key(u);
      return k ? at[k] : undefined;
    },
    seenHost: (u) => {
      const h = u ? hostOf(u) : null;
      return Boolean(h) && hosts.has(h);
    },
    dropped: { count: 0 },
  };
}

export async function runTask<Input, Parsed, Out>(
  ctx: AiContext,
  def: TaskDef<Input, Parsed, Out>,
  input: Input,
): Promise<TaskResult<Out>> {
  if (!ctx.transport) throw new AiError("not_configured");
  let reserveUsd = reserveFor(def);
  let web = def.web;
  let maxContinuations = def.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
  let trimmed = false;

  // P6: per-run cap, in memory first (the database checks it again inside reserve_ai_call). A call with web tools
  // that does not fit asks for fewer searches instead (modo econômico); its reserve is still the worst case of the
  // call that is actually sent, so the run cap is never exceeded by more than before.
  if (ctx.runBudget) {
    const remaining = Math.round((ctx.runBudget.maxUsd - ctx.runBudget.spentUsd) * 1_000_000) / 1_000_000;
    if (reserveUsd > remaining) {
      const fitted = def.web ? fitWebToBudget(def.model, def.maxTokens, def.web, maxContinuations, remaining, def.reserveUsd ?? 0) : null;
      if (!fitted) throw new AiError("run_cap");
      ({ web, maxContinuations, reserveUsd, trimmed } = fitted);
    }
  }

  let callId: string | null = null;
  if (ctx.ledger.reserve) {
    const caps = aiSpendCaps();
    callId = await ctx.ledger.reserve({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      task: def.task,
      model: def.model,
      promptVersion: def.promptVersion,
      reserveUsd,
      userDailyCapUsd: caps.userDailyUsd,
      globalDailyCapUsd: caps.globalDailyUsd,
    });
  } else {
    // Legacy ledger (no atomic reservation): check, then call.
    const [cap, spent] = await Promise.all([ctx.ledger.dailyCapUsd(ctx.workspaceId), ctx.ledger.spentTodayUsd(ctx.workspaceId)]);
    if (spent + reserveUsd > cap) throw new AiError("daily_cap");
  }

  const schema = typeof def.schema === "function" ? def.schema(input) : def.schema;
  const req: AiRequest = {
    task: def.task,
    model: def.model,
    system: def.system,
    // The model is told the web budget it really has (the API enforces it as max_uses).
    user: web ? `${def.buildUser(input)}\n${budgetLine(web)}` : def.buildUser(input),
    jsonSchema: jsonSchemaFor(schema),
    effort: def.effort,
    maxTokens: def.maxTokens,
    web,
    maxContinuations,
    ...(ctx.deadlineMs !== undefined ? { deadlineMs: Math.max(1, Math.floor(ctx.deadlineMs)) } : {}),
  };

  const finish = (usage: AiUsage, costUsd: number, status: AiCallStatus, error: string | null, durationMs: number) => {
    const row: AiCallRecord = {
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      task: def.task,
      model: def.model,
      promptVersion: def.promptVersion,
      usage,
      costUsd,
      status,
      error: error ? error.slice(0, 300) : null,
      durationMs,
    };
    return callId && ctx.ledger.settle ? ctx.ledger.settle(callId, row) : ctx.ledger.record(row);
  };

  const started = Date.now();
  let res: AiResponse;
  try {
    res = await ctx.transport.send(req);
  } catch (e) {
    // Tokens billed before the failure (finished continuations, the interrupted request) are recorded (finding 4).
    const usage = e instanceof AiTransportFailure ? e.usage : ZERO_USAGE;
    const costUsd = estimateCostUsd(def.model, usage);
    if (ctx.runBudget) ctx.runBudget.spentUsd += costUsd;
    await finish(usage, costUsd, "error", errorText(e), Date.now() - started);
    throw new AiError("transport", errorText(e));
  }
  const durationMs = Date.now() - started;
  const costUsd = estimateCostUsd(def.model, res.usage);
  if (ctx.runBudget) ctx.runBudget.spentUsd += costUsd;

  if (res.stop === "refusal") {
    await finish(res.usage, costUsd, "refused", res.refusalCategory ?? null, durationMs);
    throw new AiError("refused", res.refusalCategory ?? undefined);
  }
  if (res.stop === "max_tokens" || res.stop === "pause_turn") {
    await finish(res.usage, costUsd, "truncated", res.stop, durationMs);
    throw new AiError("truncated");
  }

  let parsed: Parsed;
  try {
    const out = schema.safeParse(extractJson(res.text));
    if (!out.success) throw new Error(out.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    parsed = out.data;
  } catch (e) {
    await finish(res.usage, costUsd, "invalid_output", errorText(e), durationMs);
    throw new AiError("invalid_output", errorText(e));
  }

  const meta = taskMeta(res, Boolean(def.web));
  let data: Out;
  try {
    data = def.normalize(parsed, input, meta);
  } catch (e) {
    // Tokens were billed; the ledger must say the output was unusable, not "ok". The error is rethrown unchanged.
    await finish(res.usage, costUsd, "invalid_output", errorText(e), durationMs);
    throw e;
  }
  await finish(res.usage, costUsd, "ok", null, durationMs);
  return { data, costUsd, usage: res.usage, droppedUrls: meta.dropped.count, ...(web ? { web: webReport(web, res, trimmed) } : {}) };
}

/** A tool-limit error is the normal end of searching inside a call, not a failure; it is only reported. */
export function webReport(web: WebTools, res: Pick<AiResponse, "usage" | "toolErrors" | "searchQueries">, trimmed = false): WebReport {
  const errors = { ...(res.toolErrors ?? {}) };
  const searchFull = Boolean(web.search) && res.usage.webSearches >= web.search!.maxUses;
  const fetchFull = Boolean(web.fetch) && res.usage.webFetches >= web.fetch!.maxUses;
  return {
    searches: res.usage.webSearches,
    fetches: res.usage.webFetches,
    queries: res.searchQueries ?? [],
    errors,
    budgetUsed: (errors.max_uses_exceeded ?? 0) > 0 || searchFull || fetchFull,
    limits: web,
    trimmed,
  };
}

function errorText(e: unknown): string {
  // Only the class and message; never request bodies or keys (R10).
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300);
  return "unknown error";
}
