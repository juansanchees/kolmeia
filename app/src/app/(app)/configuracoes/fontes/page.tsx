import { notFound } from "next/navigation";
import { ConnectionCard, type ConnectionView } from "@/components/sources/ConnectionCard";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { t } from "@/messages/pt";

type Row = { provider: string; last4: string; daily_cap_usd: number | null; daily_calls: number | null; spent_today_usd: number | null; calls_today: number | null };

// Owner: connect, replace, cap, disconnect. SDR: read-only. Closer: not found. Only the last 4 characters are read.
export default async function SourcesPage() {
  const workspace = await getCurrentWorkspace();
  if (!workspace || !isSender(workspace.role)) notFound();
  const supabase = await createClient();
  const { data } = supabase ? await supabase.rpc("list_source_connections", { p_ws: workspace.id }) : { data: null };
  const rows = (Array.isArray(data) ? data : []) as Row[];
  const views: ConnectionView[] = (["apify", "apollo"] as const).map((provider) => {
    const r = rows.find((x) => x.provider === provider);
    if (!r) return { provider, last4: null, cap: null, today: null };
    return provider === "apify"
      ? { provider, last4: r.last4, cap: r.daily_cap_usd === null ? null : Number(r.daily_cap_usd), today: r.spent_today_usd === null ? null : Number(r.spent_today_usd) }
      : { provider, last4: r.last4, cap: r.daily_calls, today: r.calls_today };
  });

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-3xl">{t.sources.title}</h2>
      <p className="text-sm">{t.sources.intro}</p>
      <div className="flex flex-wrap items-start gap-5">
        {views.map((v) => (
          <ConnectionCard key={v.provider} view={v} isOwner={workspace.role === "owner"} />
        ))}
      </div>
    </section>
  );
}
