import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";

// /u and /api/unsubscribe: the public unsubscribe page and its one-click endpoint (read by e-mail recipients).
// /api/scheduler: the clock (E1) has no session; it proves itself with a token that the database checks.
// /api/hunter: the Caçador clock (F3b), same rule as /api/scheduler (bearer token checked by the database).
// /bot: the public page the robot's User-Agent points to (read by site owners, logged out).
// /site: the public landing page. Anonymous visitors get it at "/" through a rewrite (below); signed-in people keep the app at "/".
const PUBLIC_PATHS = ["/login", "/u", "/api/unsubscribe", "/api/scheduler", "/api/hunter", "/site", "/bot"];

/** Refreshes the session cookie, shows the landing to anonymous visitors at "/" and sends them to /login everywhere else. No-op when the database is not configured. */
export async function updateSession(request: NextRequest) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        // Cache-Control: private, no-store and friends: keeps CDNs from caching a response that carries a session cookie.
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  // getClaims validates the JWT signature; do not run code between client creation and this call.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!signedIn && path === "/") {
    const rewrite = NextResponse.rewrite(new URL("/site", request.url));
    response.cookies.getAll().forEach((c) => rewrite.cookies.set(c));
    return rewrite;
  }
  if (!signedIn && !isPublic) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  if (signedIn && path === "/login") {
    const redirect = NextResponse.redirect(new URL("/", request.url));
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  return response;
}
