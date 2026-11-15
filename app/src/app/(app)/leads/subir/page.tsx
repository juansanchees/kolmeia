import { requireSender } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { listImports } from "@/lib/imports/store";
import { ImportWizard } from "@/components/imports/ImportWizard";
import { profileEstimateUsd } from "@/lib/ai/profile-tasks";
import { ImportHistory } from "@/components/imports/ImportHistory";

// Sender-only (the closer is sent back to LEADS). Reads as the user: RLS keeps the history to this workspace.
export default async function UploadListPage() {
  const workspace = await requireSender();
  const supabase = await createClient();
  const items = supabase ? await listImports(supabase, workspace.id) : [];
  // newest learned profile of each import, for the "Ver perfil aprendido" links
  const profiles: Record<string, string> = {};
  if (supabase) {
    const { data } = await supabase.from("learned_profiles").select("id, import_id").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(200);
    for (const p of data ?? []) if (p.import_id && !(p.import_id in profiles)) profiles[p.import_id as string] = p.id as string;
  }
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ImportWizard />
      <ImportHistory items={items} profiles={profiles} trainEstimateUsd={profileEstimateUsd()} />
    </div>
  );
}
