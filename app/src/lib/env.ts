import { z } from "zod";

// Empty string counts as "not set" so `.env` lines like KEY= keep the feature off (same convention as site/).
const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/**
 * The ONLY variables this app reads. No service-role key exists in this product (rule R14).
 * ANTHROPIC_API_KEY is server-only: it is read in src/lib/ai/config.ts (imports "server-only"), never here, so it
 * can never be inlined into a client bundle. Without it the AI features show "IA não configurada".
 * MAILBOX_ENC_KEY is server-only too (base64 of 32 bytes; encrypts mailbox app passwords). It is read only in
 * src/lib/email/config.ts and validated lazily there, so the app builds and Pesquisa works without it.
 * MAILBOX_ENC_KEY_PREVIOUS (optional) is the old key during a rotation: it only decrypts.
 * APP_PUBLIC_ORIGIN is server-only too: the https origin used to build unsubscribe links (e.g.
 * https://radar-hvac.vercel.app). Real sends are refused unless it is an https, non-localhost origin.
 */
export const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: opt,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  /** Server-only, optional: US$ per user per day across all their workspaces (default 10). Read in src/lib/ai/config.ts. */
  AI_USER_DAILY_CAP_USD: opt,
  /** Server-only, optional: US$ per day across every workspace of this deployment (default 25). */
  AI_GLOBAL_DAILY_CAP_USD: opt,
  MAILBOX_ENC_KEY: opt,
  MAILBOX_ENC_KEY_PREVIOUS: opt,
  APP_PUBLIC_ORIGIN: opt,
});

const publicEnvSchema = envSchema.pick({ NEXT_PUBLIC_SUPABASE_URL: true, NEXT_PUBLIC_SUPABASE_ANON_KEY: true });

// NEXT_PUBLIC_* must be referenced literally so Next can inline them in the client bundle.
export const env = publicEnvSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

export const hasSupabase = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
