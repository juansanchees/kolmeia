import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { RunList, type RunListItem } from "@/components/research/RunList";
import { t } from "@/messages/pt";

export default async function ResearchLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  let runs: RunListItem[] = [];
  if (supabase && workspace) {
    const { data } = await supabase
      .from("research_runs")
      .select("id, title, status, is_partial, created_at")
      .eq("workspace_id", workspace.id)
      .is("setup_agent_id", null)
      .order("created_at", { ascending: false })
      .limit(50);
    runs = (data ?? []) as RunListItem[];
  }
  return (
    <div className="flex flex-wrap items-start gap-6">
      <aside aria-label={t.research.yourResearch} className="flex min-w-0 flex-[1_1_240px] flex-col gap-3">
        <RunList runs={runs} />
      </aside>
      <div className="min-w-0 flex-[999_1_560px]">{children}</div>
    </div>
  );
}
