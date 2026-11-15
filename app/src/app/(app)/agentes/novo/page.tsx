import { requireSender } from "@/lib/workspace";
import { hasAi } from "@/lib/ai/config";
import { createClient } from "@/lib/supabase/server";
import { AgentGallery } from "@/components/agents/AgentGallery";

// `?regiao=` comes from [Caçar ▸] on the Cobertura tab (searchParams is a Promise in Next 16 pages).
export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const workspace = await requireSender();
  const q = (await searchParams).regiao;
  const defaultRegion = typeof q === "string" ? q.trim().slice(0, 100) : "";
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
  return <AgentGallery hasProfile={whatWeDo.length > 0} serviceArea={serviceArea} ai={hasAi()} defaultRegion={defaultRegion} />;
}
