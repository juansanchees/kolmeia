import { urlKey } from "@/lib/safe-url";
import type { AiRequest, AiResponse, AiTask, AiTransport, AiUsage } from "@/lib/ai/types";

export const USAGE: AiUsage = { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, webFetches: 0 };

type Handler = (req: AiRequest, n: number) => Partial<AiResponse> & { json?: unknown; throws?: unknown };

const URLS = /https?:\/\/[^\s"'<>\\]+/g;

/**
 * In-memory transport: no network. Records every request so tests can assert on what the model was given.
 * Unless a handler says otherwise, it reports every URL in its own answer (and in the request) as returned by the
 * web tools and opened with fetch, like a real call where the model cites what it read. A handler that wants to
 * simulate an invented URL passes `seenUrls` (and optionally `fetchedUrls` / `triedUrls`) explicitly.
 */
export class FakeTransport implements AiTransport {
  readonly calls: AiRequest[] = [];
  private readonly counts = new Map<AiTask, number>();

  constructor(private readonly handlers: Partial<Record<AiTask, Handler>>) {}

  async send(req: AiRequest): Promise<AiResponse> {
    this.calls.push(req);
    const n = this.counts.get(req.task) ?? 0;
    this.counts.set(req.task, n + 1);
    const h = this.handlers[req.task];
    if (!h) throw new Error(`no fake handler for ${req.task}`);
    const out = h(req, n);
    if (out.throws) throw out.throws;
    const text = out.text ?? JSON.stringify(out.json ?? {});
    const all = [...new Set([...`${text} ${req.user}`.matchAll(URLS)].map((m) => urlKey(m[0])).filter((k): k is string => Boolean(k)))];
    const seenUrls = (out.seenUrls ?? all).map((u) => urlKey(u) ?? u);
    return {
      stop: out.stop ?? "end_turn",
      text,
      usage: out.usage ?? USAGE,
      refusalCategory: out.refusalCategory ?? null,
      seenUrls,
      fetchedUrls: (out.fetchedUrls ?? seenUrls).map((u) => urlKey(u) ?? u),
      triedUrls: (out.triedUrls ?? seenUrls).map((u) => urlKey(u) ?? u),
      seenAt: out.seenAt ?? {},
      toolErrors: out.toolErrors ?? {},
      searchQueries: out.searchQueries ?? [],
    };
  }

  callsFor(task: AiTask) {
    return this.calls.filter((c) => c.task === task);
  }
}
