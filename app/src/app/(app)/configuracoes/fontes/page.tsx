import { notFound } from "next/navigation";
import { ConnectionCard, type ConnectionView } from "@/components/sources/ConnectionCard";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { Notice, StepTitle } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

type Row = {
  provider: string;
  last4: string;
  daily_cap_usd: number | null;
  daily_calls: number | null;
  spent_today_usd: number | null;
  calls_today: number | null;
  monthly_records: number | null;
  used_month: number | null;
  monthly_sites: number | null;
  used_sites: number | null;
};
const n = (v: number | null) => (v === null ? null : Number(v));

// Owner: connect, replace, cap, disconnect. SDR: read-only. Closer: not found. Only the last 4 characters are read.
export default async function SourcesPage() {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  if (!workspace || !isSender(workspace.role)) notFound();
  const supabase = await createClient();
  const { data, error } = supabase ? await supabase.rpc("list_source_connections", { p_ws: workspace.id }) : { data: null, error: null };
  if (!supabase || error) {
    return (
      <section className="flex flex-col gap-4">
        <StepTitle>{t.sources.title}</StepTitle>
        <Notice tone="warn" role="alert">{t.sources.errors.generic}</Notice>
      </section>
    );
  }
  const rows = (Array.isArray(data) ? data : []) as Row[];
  const views: ConnectionView[] = (["apify", "apollo", "shovels", "rapidapi"] as const).map((provider) => {
    const r = rows.find((x) => x.provider === provider);
    if (!r) return { provider, last4: null, cap: null, today: null };
    if (provider === "apify") return { provider, last4: r.last4, cap: n(r.daily_cap_usd), today: n(r.spent_today_usd) };
    if (provider === "shovels") return { provider, last4: r.last4, cap: n(r.monthly_records), today: n(r.used_month) };
    if (provider === "rapidapi") return { provider, last4: r.last4, cap: n(r.monthly_records), today: n(r.used_month), sites: { cap: n(r.monthly_sites), used: n(r.used_sites) } };
    return { provider, last4: r.last4, cap: n(r.daily_calls), today: n(r.calls_today) };
  });

  return (
    <section className="flex flex-col gap-4">
      <StepTitle hint={t.sources.intro}>{t.sources.title}</StepTitle>
      <div className="flex flex-wrap items-start gap-5">
        {views.map((v) => (
          <ConnectionCard key={v.provider} view={v} isOwner={workspace.role === "owner"} />
        ))}
      </div>
    </section>
  );
}
