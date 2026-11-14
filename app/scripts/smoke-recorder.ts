// Shared helpers for the real-API research smokes: a recording SDK client (raw content block types, search errors,
// tool inputs) and a spend guard. Never prints env values; error texts go through redact().
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync } from "node:fs";
import type { StreamClient } from "@/lib/ai/anthropic-transport";
import { redact } from "./smoke-env";

type Msg = Anthropic.Beta.Messages.BetaMessage;

export function logger(file: string) {
  return (...a: unknown[]) => appendFileSync(file, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
}

/** One line per raw block of a finished request: type, tool name/input, search result count or error code. */
export function describeContent(content: Msg["content"]): string[] {
  const out: string[] = [];
  for (const raw of content) {
    const b = raw as unknown as Record<string, unknown>;
    const type = String(b.type);
    if (type === "server_tool_use") {
      const input = b.input as Record<string, unknown> | undefined;
      const caller = (b.caller as { type?: string } | undefined)?.type;
      out.push(`server_tool_use ${String(b.name)} ${JSON.stringify(input ?? {}).slice(0, 200)}${caller ? ` caller=${caller}` : ""}`);
    } else if (type === "web_search_tool_result") {
      const c = b.content as unknown;
      if (Array.isArray(c)) out.push(`web_search_tool_result results=${c.length} urls=${c.slice(0, 10).map((r) => (r as { url?: string }).url).join(" ")}`);
      else out.push(`web_search_tool_result ERROR ${JSON.stringify(c).slice(0, 200)}`);
    } else if (type === "web_fetch_tool_result") {
      const c = b.content as { type?: string; url?: string; error_code?: string } | undefined;
      out.push(`web_fetch_tool_result ${c?.type} ${c?.url ?? ""} ${c?.error_code ?? ""}`);
    } else if (type === "code_execution_tool_result" || type === "bash_code_execution_tool_result") {
      const c = b.content as { stdout?: string; stderr?: string; type?: string; error_code?: string } | undefined;
      const stdout = c?.stdout ?? "";
      out.push(`${type} ${c?.type ?? ""} ${c?.error_code ?? ""} stdout=${stdout.length}ch urls=${(stdout.match(/https?:\/\//g) ?? []).length} stdoutHead=${JSON.stringify(stdout.slice(0, 300))}`);
    } else if (type === "text") {
      out.push(`text ${String(b.text).length}ch ${JSON.stringify(String(b.text).slice(0, 160))}`);
    } else {
      out.push(type);
    }
  }
  return out;
}

/** Wraps the real SDK client so every finished request is logged (stop reason, usage, block list). */
export function recordingClient(apiKey: string, log: (...a: unknown[]) => void, label: () => string): StreamClient {
  const real = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    beta: {
      messages: {
        stream(body, options) {
          const s = real.beta.messages.stream(body as never, options);
          const tools = (body.tools ?? []).map((t) => `${(t as { type: string }).type}:${(t as { max_uses?: number }).max_uses ?? "-"}`).join(",");
          return {
            async finalMessage() {
              try {
                const m = (await s.finalMessage()) as Msg;
                const u = m.usage;
                log(`  [raw ${label()}] tools=${tools} stop=${m.stop_reason} in=${u.input_tokens} out=${u.output_tokens} cacheR=${u.cache_read_input_tokens} cacheW=${u.cache_creation_input_tokens} searches=${u.server_tool_use?.web_search_requests ?? 0} fetches=${u.server_tool_use?.web_fetch_requests ?? 0}`);
                for (const line of describeContent(m.content)) log(`     ${line}`);
                return m;
              } catch (e) {
                log(`  [raw ${label()}] ERROR ${redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
                throw e;
              }
            },
            get currentMessage() {
              return s.currentMessage as Msg | undefined;
            },
          };
        },
      },
    },
  };
}
