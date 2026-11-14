import { requireSender } from "@/lib/workspace";
import { hasAi } from "@/lib/ai/config";
import { createClient } from "@/lib/supabase/server";
import { AgentGallery } from "@/components/agents/AgentGallery";

export default async function NewAgentPage() {
  const workspace = await requireSender();
  const supabase = await createClient();
  let whatWeDo = "";
  let serviceArea = "";
  if (supabase) {
    const { data } = await supabase
      .from("company_profiles")
      .select("what_we_do, service_area")
      .eq("workspace_id", workspace.id)
      .maybeSingle();
    whatWeDo = String(data?.what_we_do ?? "").trim();
    serviceArea = String(data?.service_area ?? "").trim();
  }
  return <AgentGallery hasProfile={whatWeDo.length > 0} serviceArea={serviceArea} ai={hasAi()} />;
}
