// Real-API measurement for finding 19: input tokens per call of each web tool variant (basic vs dynamic filtering).
// Run: SMOKE_ENV_FILE=<path> SMOKE_LOG=<file> npx vitest run --config scripts/vitest.smoke.config.mts smoke-diag
// Four small Sonnet calls (about US$ 0.15 in total). Never prints env values.
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { BLOCKED_DOMAINS } from "@/lib/ai/anthropic-transport";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { MODELS } from "@/lib/ai/models";
import { loadSmokeEnv, redact } from "./smoke-env";

loadSmokeEnv();
const LOG = process.env.SMOKE_LOG ?? "smoke-diag.log";
writeFileSync(LOG, "");
const out = (s: string) => appendFileSync(LOG, s + "\n");

type Variant = { label: string; tool: Anthropic.Beta.Messages.BetaToolUnion; prompt: string };

const URL = "https://hamblinhomes.com/";
const VARIANTS: Variant[] = [
  { label: "fetch basic web_fetch_20250910", tool: { type: "web_fetch_20250910", name: "web_fetch", max_uses: 1, max_content_tokens: 8000, blocked_domains: BLOCKED_DOMAINS }, prompt: `Fetch ${URL} and say in one sentence what the company does.` },
  { label: "fetch dynamic web_fetch_20260209", tool: { type: "web_fetch_20260209", name: "web_fetch", max_uses: 1, max_content_tokens: 8000, blocked_domains: BLOCKED_DOMAINS }, prompt: `Fetch ${URL} and say in one sentence what the company does.` },
  { label: "search basic web_search_20250305", tool: { type: "web_search_20250305", name: "web_search", max_uses: 1, blocked_domains: BLOCKED_DOMAINS }, prompt: "Search once for 'Falmouth MA building permits portal' and name the portal in one sentence." },
  { label: "search dynamic web_search_20260209", tool: { type: "web_search_20260209", name: "web_search", max_uses: 1, blocked_domains: BLOCKED_DOMAINS }, prompt: "Search once for 'Falmouth MA building permits portal' and name the portal in one sentence." },
];

test("diag web tool variants", async () => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", maxRetries: 0 });
  let total = 0;
  out("variant | ok | input | output | searches | fetches | cost | block types");
  for (const v of VARIANTS) {
    try {
      const m = await client.beta.messages
        .stream({ model: MODELS.sonnet, max_tokens: 2000, output_config: { effort: "low" }, messages: [{ role: "user", content: v.prompt }], tools: [v.tool] })
        .finalMessage();
      const u = m.usage;
      const usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        webSearches: u.server_tool_use?.web_search_requests ?? 0,
        webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
      };
      const cost = estimateCostUsd(MODELS.sonnet, usage);
      total += cost;
      out(`${v.label} | ${m.stop_reason} | ${usage.inputTokens} | ${usage.outputTokens} | ${usage.webSearches} | ${usage.webFetches} | ${cost.toFixed(4)} | ${m.content.map((b) => b.type).join(",")}`);
    } catch (e) {
      out(`${v.label} | ERROR ${redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
    }
  }
  out(`TOTAL ${total.toFixed(4)}`);
});
