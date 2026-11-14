// The closer brief as stored (jsonb). Written only through save_closer_brief() (shape checked in SQL), but the
// screen still parses it defensively: an unexpected shape shows "sem resumo" instead of crashing the page, and
// every link goes through the same URL filter as the rest of the app. Client-safe.
import { z } from "zod";
import { sanitizeUrl } from "@/lib/safe-url";
import type { CloserBrief } from "./types";

const briefSchema = z.object({
  who: z.string().max(600),
  what_they_said: z.string().max(800),
  next_step: z.string().max(400),
  evidence_urls: z.array(z.string().max(2000)).max(4),
  model: z.string().max(60),
});

export function parseCloserBrief(raw: unknown): CloserBrief | null {
  const r = briefSchema.safeParse(raw);
  if (!r.success) return null;
  const urls = r.data.evidence_urls.map((u) => sanitizeUrl(u)).filter((u): u is string => Boolean(u));
  return { ...r.data, evidence_urls: [...new Set(urls)] };
}
