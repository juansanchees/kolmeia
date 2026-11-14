import { requireSender } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { listImports } from "@/lib/imports/store";
import { ImportWizard } from "@/components/imports/ImportWizard";
import { ImportHistory } from "@/components/imports/ImportHistory";

// Sender-only (the closer is sent back to LEADS). Reads as the user: RLS keeps the history to this workspace.
export default async function UploadListPage() {
  const workspace = await requireSender();
  const supabase = await createClient();
  const items = supabase ? await listImports(supabase, workspace.id) : [];
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ImportWizard />
      <ImportHistory items={items} />
    </div>
  );
}
