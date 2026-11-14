import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { isSender } from "@/lib/roles";
import { listLeads } from "@/lib/leads/queries";
import { LeadsTable } from "@/components/leads/LeadsTable";

// The unified list: one row per company. Read as the user (RLS: the closer only gets leads assigned to her).
export default async function LeadsPage() {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  const items = supabase && workspace ? await listLeads(supabase, workspace.id) : [];
  return <LeadsTable items={items} canCreate={isSender(workspace?.role ?? "closer")} />;
}
