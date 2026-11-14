import "server-only";
import { ZERO_USAGE, type AiUsage } from "./types";

export type AiErrorCode =
  | "not_configured"
  /** The user is not on the AI allowlist (public.ai_access). */
  | "no_access"
  | "daily_cap"
  /** Per-user daily cap (all the user's workspaces together). */
  | "user_cap"
  /** Daily cap across every workspace (protects the operator's key). */
  | "global_cap"
  | "run_cap"
  /** The run's time cap passed (checked by the database against the trigger-owned started_at). */
  | "run_time"
  | "refused"
  | "invalid_output"
  | "truncated"
  | "transport";

/** Typed failure of an AI call. The UI maps `code` to a message in messages/pt/ai.ts. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AiError";
  }
}

export function isAiError(e: unknown): e is AiError {
  return e instanceof AiError;
}

/** Codes that stop spending until a human acts (the step loop must not retry them). */
export const STOP_CODES: ReadonlySet<AiErrorCode> = new Set([
  "not_configured",
  "no_access",
  "daily_cap",
  "user_cap",
  "global_cap",
  "run_cap",
  "run_time",
  "refused",
]);

/**
 * Thrown by a transport when the call failed or timed out after tokens may already have been billed. Carries the
 * usage accumulated so far (finished continuations plus whatever the interrupted request reported), so the ledger
 * records real spend instead of zero (finding 4).
 */
export class AiTransportFailure extends Error {
  constructor(
    message: string,
    readonly usage: AiUsage = ZERO_USAGE,
    readonly timedOut = false,
    /** The underlying error (SDK error class), for the transport's own fallback decision. Never logged as is. */
    readonly original?: unknown,
  ) {
    super(message);
    this.name = "AiTransportFailure";
  }
}

const CAP_CODES = new Set<AiErrorCode>(["no_access", "daily_cap", "user_cap", "global_cap", "run_cap", "run_time"]);

/** reserve_ai_call raises "ai_cap:<code>"; turns that database message into the typed error (null otherwise). */
export function aiCapErrorFrom(message: string | null | undefined): AiError | null {
  const m = message?.match(/ai_cap:([a-z_]+)/);
  return m && CAP_CODES.has(m[1] as AiErrorCode) ? new AiError(m[1] as AiErrorCode) : null;
}
