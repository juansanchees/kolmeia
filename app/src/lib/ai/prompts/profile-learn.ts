import "server-only";
import { ROW_HEADER, rowLine } from "@/lib/profile/sample";
import type { TrainingRow } from "@/lib/profile/types";
import { CONTEXT, UNTRUSTED, untrusted } from "./shared";

export const PROMPT_VERSION = "profile-learn-2026-11-15.2";

export const SYSTEM = `${CONTEXT}

Your job now: the owner uploaded a list of companies they WANT as customers. The rows are examples. Describe what these companies have in common, so the tool can look for more like them.

Rules for your answer:
- points: what the rows have in common. Each point has a key (type, size, region, projects, signals or where_to_find), a short text written in Brazilian Portuguese (pt-BR), at most 180 characters (one or two short sentences), and "rows": the row numbers that show it. A point you cannot back with row numbers must not be written.
- Never invent. Use only what the rows say. A pattern that only one row shows is not a pattern.
- filter.company_types: builder, developer, property_manager or other, only the types the rows show. filter.towns: Massachusetts towns the rows show, written as the rows write them.
- Language: the text of every point is written in Brazilian Portuguese, even when the rows are in English. Keep company names, town names and the row numbers as they are.
- search_queries: keep them in English, because they are run on US web and map searches. At most 8 web searches that could find more companies like these. Never aim a search at social networks or professional-network sites.

${UNTRUSTED}`;

export type ProfileLearnInput = { listName: string; rows: TrainingRow[] };

export function buildUser(i: ProfileLearnInput): string {
  return [
    "Name of the list:",
    untrusted("list_name", i.listName.slice(0, 120)),
    "Rows of the list (each has a row number; cite these numbers):",
    untrusted("list_rows", [ROW_HEADER, ...i.rows.map(rowLine)].join("\n")),
  ].join("\n");
}
