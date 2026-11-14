import "server-only";
import { headers } from "next/headers";
import { defaultTransport } from "@/lib/ai/gateway";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { unsubscribeOrigin } from "./compose";
import { configuredPublicOrigin } from "./config";
import type { EmailDeps, Origins } from "./engine";
import { SupabaseEmailStore } from "./supabase-store";
import { GmailImap, GmailSmtp } from "./transport";

/** The e-mail store and transports bound to the logged-in user's session (RLS applies), or null when signed out. */
export async function emailSession() {
  const supabase = await createClient();
  const user = await getUser();
  const workspace = await getCurrentWorkspace();
  if (!supabase || !user || !workspace) return null;
  const store = new SupabaseEmailStore(supabase);
  const deps: EmailDeps = { store, ai: defaultTransport(), smtp: new GmailSmtp(), imap: new GmailImap() };
  return { supabase, user, workspace, store, deps, canSend: workspace.role === "owner" || workspace.role === "sdr" };
}

/**
 * Origin of the current request. NOT trusted for real mail (the Host header can be anything): real sends and the
 * test message use only APP_PUBLIC_ORIGIN (emailOrigins / unsubscribeOrigin). Used for rehearsal and previews.
 */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0].trim();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = local ? (h.get("x-forwarded-proto")?.split(",")[0].trim() ?? "http") : "https";
  return `${proto}://${host}`;
}

/** The configured public origin (APP_PUBLIC_ORIGIN) and the request origin (rehearsal/preview fallback only). */
export async function emailOrigins(): Promise<Origins> {
  return { publicOrigin: configuredPublicOrigin(), requestOrigin: await requestOrigin() };
}

/** Origin for previews on the review screens: the public one when configured, else the request's. */
export async function previewOrigin(): Promise<string> {
  const o = await emailOrigins();
  return unsubscribeOrigin(false, o.publicOrigin, o.requestOrigin) ?? "https://example.invalid";
}
