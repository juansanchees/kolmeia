import { unsubscribeByToken } from "@/lib/email/unsubscribe";

// RFC 8058 one-click unsubscribe. The List-Unsubscribe header of every e-mail points here.
//  * POST (mail client one-click, body "List-Unsubscribe=One-Click", or the confirm button of /u/[token]) unsubscribes.
//  * GET never changes anything (link scanners prefetch URLs): it sends the person to the confirm page.
// No session needed (the proxy lets /api/unsubscribe through); no cookies read; nothing about the recipient returned.

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return Response.redirect(new URL(`/u/${encodeURIComponent(token)}`, request.url), 303);
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const result = await unsubscribeByToken(token);
  const fromPage = new URL(request.url).searchParams.get("from") === "page";
  if (fromPage) {
    const to = new URL(`/u/${encodeURIComponent(token)}`, request.url);
    to.searchParams.set(result === "unavailable" ? "error" : "done", "1");
    return Response.redirect(to, 303);
  }
  // One-click: the same answer for a known or unknown token (nothing to learn by probing).
  if (result === "unavailable") return new Response("Please try again later.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response("You are unsubscribed.", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
