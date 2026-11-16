import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { isSender } from "@/lib/roles";
import { listLeads, listViews } from "@/lib/leads/queries";
import { DEFAULT_LEAD_FILTERS } from "@/lib/leads/view";
import { listLeadIds, listNames } from "@/lib/lists/queries";
import { connectedSources } from "@/lib/sources/queries";
import { LeadsTable } from "@/components/leads/LeadsTable";
import { reserveFor } from "@/lib/ai/gateway";
import { answerDef } from "@/lib/ai/lead-ai-tasks";
import { listAnswers, listQuestions } from "@/lib/ai-questions/store";

// Server actions posted from this page ("Checar e-mails", "Achar e-mail") run DNS look-ups in rounds: give them time.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The unified list: one row per company. Read as the user (RLS: the closer only gets leads assigned to her).
// ?lista=<id> shows one named list (owner/sdr). Tab and left-panel counts are computed from these rows on the client.
export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  const sender = isSender(workspace?.role ?? "closer");
  if (!supabase || !workspace) return <LeadsTable items={[]} canCreate={false} />;

  const [views, lists, questions] = await Promise.all([listViews(supabase, workspace.id), sender ? listNames(supabase, workspace.id) : [], listQuestions(supabase, workspace.id)]);
  const pick = (await searchParams).lista;
  const list = typeof pick === "string" && UUID.test(pick) ? (lists.find((l) => l.id === pick) ?? null) : null;
  // Senders open on "Novos" (never contacted); the closer's leads were all handed to her, so she opens on "Todos".
  const initial = views.find((v) => v.is_default)?.filters ?? { ...DEFAULT_LEAD_FILTERS, contact: sender ? ("new" as const) : ("all" as const) };

  const [items, conn] = await Promise.all([
    list ? listLeadIds(supabase, list.id).then((ids) => listLeads(supabase, workspace.id, { ids })) : listLeads(supabase, workspace.id),
    // "Buscar" buttons: senders only, and only for sources the workspace connected (the closer never reads connections).
    sender ? connectedSources(supabase, workspace.id) : null,
  ]);
  // AI-question answers (0029), attached per lead; RLS gives the closer only her leads' answers
  const answers = await listAnswers(supabase, workspace.id, questions.map((q) => q.id));
  for (const i of items) i.ai = answers.get(i.lead.id);
  return (
    <LeadsTable
      items={items}
      canCreate={isSender(workspace.role)}
      sources={{ maps: conn?.maps ?? false, apollo: conn?.apollo ?? false }}
      initialFilters={initial}
      views={views}
      lists={lists}
      list={list}
      questions={questions}
      answerReserveUsd={reserveFor(answerDef)}
    />
  );
}
