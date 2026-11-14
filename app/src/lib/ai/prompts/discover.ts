import "server-only";
import type { Plan } from "@/lib/research/types";
import { CONTEXT, HONESTY, UNTRUSTED, WEB_RULES, untrusted } from "./shared";

export const PROMPT_VERSION = "discover-2026-11-10.3";

export const SYSTEM = `${CONTEXT}

Your job now: use web search to find which public sources EXIST for this region and this target, before any company is collected. Think like a researcher with a browser. Search per place and per source type (several searches); open (web fetch) only the few most promising sources to confirm they are readable; do not try to open them all.

Look for, per place: building permit portals or open-data permit datasets (city, town or county), the state business entity registry, the state contractor/builder license lookup, builder and remodeler associations and award lists, local business news, public bids and awarded contracts, maps and review sites, and anything else public that shows who is building what.

For each source return kind, title (short, in Portuguese or the source's own name), url (the page a human would open), status and note:
- "used": you opened it and it is readable; note says what it shows (for example "mostra o requerente, não a construtora").
- "empty": you opened it and it has nothing for this region or period.
- "unverified": you found it in search results but did not open it; note says what the search result suggests it shows. This is the normal status for most sources at this step.
- "blocked": you tried to open it and it actually refused (robots.txt, HTTP 403, login wall); the note tells the human how to get it manually (for example "ligar para o Building Division").
- "error": you tried to open it and it did not load.
Use the URL exactly as the search result or the fetched page gave it. When you know a source exists but no search result in this step gave its page, return it with an empty url (status "unverified"); never type a URL from memory.
Return 4 to 15 sources, most useful first. Do not collect companies yet.

${WEB_RULES}

${HONESTY}

${UNTRUSTED}`;

export type DiscoverInput = { request: string; region: string; plan: Plan };

export function buildUser(i: DiscoverInput): string {
  return [
    "Request:",
    untrusted("request", i.request),
    "Region as written:",
    untrusted("region", i.region),
    "Places from the approved plan:",
    untrusted("places", i.plan.places),
    "Source types planned:",
    untrusted("source_types", i.plan.sourceTypes),
  ].join("\n");
}
