// Fake HttpJson for the sources tests: no network, ever.
import type { HttpJson } from "@/lib/sources/http";

export type FakeRoute = { status: number; json: unknown; headers?: Record<string, string> } | Error;

/**
 * Routes are keyed "METHOD url-prefix" (e.g. "GET https://api.apify.com/v2/users/me"); the longest matching prefix wins.
 * An Error route is thrown. No match throws (a test that calls an unplanned URL fails loudly).
 */
export function fakeHttp(routes: Record<string, FakeRoute>): HttpJson & { calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] } {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  return {
    calls,
    async request(method, url, o) {
      calls.push({ method, url, headers: o.headers, body: o.body });
      const full = `${method} ${url}`;
      const key = Object.keys(routes)
        .filter((k) => full.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (!key) throw new Error(`fakeHttp: no route for ${full}`);
      const r = routes[key];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
