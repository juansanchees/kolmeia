import "server-only";

// Model per task (docs/mvp-harness.md 11.6 and the F1-F3 brief). Ids without date suffixes.
export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** Server-side refusal fallback ("fallbacks": "default") exists for Opus 5.5 and Sonnet 5.5, not for Haiku 5.5. */
export function supportsServerFallback(model: ModelId): boolean {
  return model === MODELS.opus || model === MODELS.sonnet;
}
