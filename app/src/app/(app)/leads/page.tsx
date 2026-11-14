import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { isSender } from "@/lib/roles";
import { listLeads } from "@/lib/leads/queries";
import { connectedSources } from "@/lib/sources/queries";
import { LeadsTable } from "@/components/leads/LeadsTable";

// The unified list: one row per company. Read as the user (RLS: the closer only gets leads assigned to her).
export default async function LeadsPage() {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  const items = supabase && workspace ? await listLeads(supabase, workspace.id) : [];
  const sender = isSender(workspace?.role ?? "closer");
  // "Buscar" buttons: senders only, and only for sources the workspace connected (the closer never reads connections).
  const conn = sender && supabase && workspace ? await connectedSources(supabase, workspace.id) : null;
  return <LeadsTable items={items} canCreate={isSender(workspace?.role ?? "closer")} sources={{ maps: conn?.maps ?? false, apollo: conn?.apollo ?? false }} />;
}
