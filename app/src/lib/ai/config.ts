import "server-only";
import { envSchema } from "@/lib/env";

/**
 * The only place that reads the Anthropic key and the AI spend caps (guard test pins this). Server-only: importing
 * this file from a client component fails the build.
 */
export function getAnthropicKey(): string | undefined {
  return envSchema.shape.ANTHROPIC_API_KEY.parse(process.env.ANTHROPIC_API_KEY);
}

export function hasAi(): boolean {
  return Boolean(getAnthropicKey());
}

export const DEFAULT_USER_DAILY_CAP_USD = 10;
export const DEFAULT_GLOBAL_DAILY_CAP_USD = 25;

function money(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Per-user and global daily caps (US$). The database clamps both to public.ai_limits, so env can only lower them. */
export function aiSpendCaps(): { userDailyUsd: number; globalDailyUsd: number } {
  return {
    userDailyUsd: money(envSchema.shape.AI_USER_DAILY_CAP_USD.parse(process.env.AI_USER_DAILY_CAP_USD), DEFAULT_USER_DAILY_CAP_USD),
    globalDailyUsd: money(envSchema.shape.AI_GLOBAL_DAILY_CAP_USD.parse(process.env.AI_GLOBAL_DAILY_CAP_USD), DEFAULT_GLOBAL_DAILY_CAP_USD),
  };
}
