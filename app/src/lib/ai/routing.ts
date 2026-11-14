import "server-only";
import type { Rigor } from "@/lib/research/types";
import { MODELS, type ModelId } from "./models";
import { worstCaseUsd } from "./pricing";
import type { WebTools } from "./types";

// "Modo econômico" (kolmeia/docs/superpowers/specs/2026-11-14-modo-economico-design.md): which model and which web
// budget each research step uses, per rigor, and how a call shrinks its web budget to fit what is left of the run's
// cost cap. Accuracy rule: every step that decides truth (verify, second pass) or shapes the search (plan) keeps its
// model; only steps whose output is checked later (discover sources, collect candidates) move to Haiku, and only
// below "strict".

export type ResearchStep = "discover" | "collect" | "verify" | "second";
export type WebLimits = { search: { maxUses: number }; fetch: { maxUses: number } };
export type Route = { model: ModelId; web: WebLimits };

/** Web limits per call for "careful" and "strict" (unchanged since 10/11/2026; docs/mvp/fase-1-3-pesquisa.md). */
const FULL: Record<ResearchStep, WebLimits> = {
  discover: { search: { maxUses: 6 }, fetch: { maxUses: 3 } },
  collect: { search: { maxUses: 8 }, fetch: { maxUses: 6 } },
  verify: { search: { maxUses: 3 }, fetch: { maxUses: 6 } },
  second: { search: { maxUses: 2 }, fetch: { maxUses: 4 } },
};

/**
 * "Rápida": fewer searches and page opens per call. It only runs the exists_active check (one page per company is
 * enough for it) and has no second pass. Collect keeps 5 searches: with 3 a round ran out before listing anyone
 * (the 10/11 "0 empresas" run).
 */
const QUICK: Record<ResearchStep, WebLimits> = {
  discover: { search: { maxUses: 3 }, fetch: { maxUses: 2 } },
  collect: { search: { maxUses: 5 }, fetch: { maxUses: 3 } },
  verify: { search: { maxUses: 2 }, fetch: { maxUses: 3 } },
  second: FULL.second,
};

export const WEB_LIMITS_BY_RIGOR: Record<Rigor, Record<ResearchStep, WebLimits>> = { quick: QUICK, careful: FULL, strict: FULL };

/**
 * Model per step and rigor. Discover and collect only propose: every company they return is checked by verify
 * (Sonnet) and every URL they cite must have been returned by a web tool, so they run on Haiku in "quick" and
 * "careful". "strict" keeps Sonnet everywhere it had it (the owner chose maximum care). Verify and second pass never
 * move: they decide what is true.
 */
export const MODEL_BY_RIGOR: Record<Rigor, Record<ResearchStep, ModelId>> = {
  quick: { discover: MODELS.haiku, collect: MODELS.haiku, verify: MODELS.sonnet, second: MODELS.opus },
  careful: { discover: MODELS.haiku, collect: MODELS.haiku, verify: MODELS.sonnet, second: MODELS.opus },
  strict: { discover: MODELS.sonnet, collect: MODELS.sonnet, verify: MODELS.sonnet, second: MODELS.opus },
};

export function routeFor(step: ResearchStep, rigor: Rigor): Route {
  return { model: MODEL_BY_RIGOR[rigor][step], web: WEB_LIMITS_BY_RIGOR[rigor][step] };
}

/** The smallest call worth making: one search and one page. Below this the step is skipped (run_cap). */
export const MIN_WEB = { search: 1, fetch: 1 } as const;
/** Shrinking first stops here; only then are pause_turn continuations dropped, then the rest. */
const SOFT_FLOOR = { search: 2, fetch: 1 } as const;

/** The reservation of the smallest call of a step (1 search, 1 page, no continuation): what the step needs to run at all. */
export function minCallUsd(model: ModelId, maxTokens: number, web: WebTools | undefined, floorUsd = 0): number {
  const min: WebTools | undefined = web && {
    ...(web.search ? { search: { ...web.search, maxUses: Math.min(web.search.maxUses, MIN_WEB.search) } } : {}),
    ...(web.fetch ? { fetch: { ...web.fetch, maxUses: Math.min(web.fetch.maxUses, MIN_WEB.fetch) } } : {}),
  };
  return Math.max(floorUsd, worstCaseUsd(model, maxTokens, min, 0));
}

export type FittedCall = { web: WebTools; maxContinuations: number; reserveUsd: number; trimmed: boolean };

/**
 * Shrinks one call's web budget until its worst-case reservation fits `remainingUsd` (the run's cap minus what it
 * already spent). The reservation stays the worst case of the call that is actually sent, so the cap guarantees do
 * not change; the call just asks for fewer searches. Order: searches and page opens down to 2 + 1, then no pause_turn
 * continuation (with this few tool uses a pause is unlikely), then down to 1 + 1. Returns null when even that does
 * not fit.
 */
export function fitWebToBudget(
  model: ModelId,
  maxTokens: number,
  web: WebTools,
  maxContinuations: number,
  remainingUsd: number,
  floorUsd = 0,
): FittedCall | null {
  let search = web.search?.maxUses ?? 0;
  let fetch = web.fetch?.maxUses ?? 0;
  let cont = maxContinuations;
  const build = (): WebTools => ({
    ...(web.search ? { search: { ...web.search, maxUses: search } } : {}),
    ...(web.fetch ? { fetch: { ...web.fetch, maxUses: fetch } } : {}),
  });
  const reserve = () => Math.max(floorUsd, worstCaseUsd(model, maxTokens, build(), cont));
  const shrink = (floor: { search: number; fetch: number }): boolean => {
    // Searches cost more (result block ~20k tokens + US$ 0.01), so the larger of the two goes first.
    if (web.search && search > floor.search && (search >= fetch || !web.fetch || fetch <= floor.fetch)) search--;
    else if (web.fetch && fetch > floor.fetch) fetch--;
    else if (web.search && search > floor.search) search--;
    else return false;
    return true;
  };
  let trimmed = false;
  while (reserve() > remainingUsd) {
    trimmed = true;
    if (shrink(SOFT_FLOOR)) continue;
    if (cont > 0) {
      cont = 0;
      continue;
    }
    if (shrink(MIN_WEB)) continue;
    return null;
  }
  return { web: build(), maxContinuations: cont, reserveUsd: reserve(), trimmed };
}
