import { DayPlan } from "@/components/home/DayPlan";
import { HomeTabs } from "@/components/home/HomeTabs";
import type { PlanInput } from "@/lib/home/plan";
import { loadHomeSetup, loadPlanData, suppressedOf } from "@/lib/home/queries";
import type { HomeRow } from "@/lib/home/rule";
import { dateLineOf } from "@/lib/home/view";
import { stageOf } from "@/lib/leads/classify";
import { listLeads, originListsOf } from "@/lib/leads/queries";
import { toTableRow } from "@/lib/leads/table";
import { originKeysOf } from "@/lib/leads/view";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import type { Person } from "@/lib/team/types";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

// Início > Plano de hoje: what to do today, read as the user (RLS: the closer only sees her own leads, tasks and calls).
export default async function HomePage() {
  const t = await getT();
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  const user = await getUser();
  if (!supabase || !workspace || !user) return null;
  const sender = isSender(workspace.role);
  const now = new Date();

  const [items, setup, people, data] = await Promise.all([
    listLeads(supabase, workspace.id),
    loadHomeSetup(supabase, workspace.id, user.id),
    sender ? supabase.rpc("list_workspace_people", { p_ws: workspace.id }).then((r) => (r.data ?? []) as Person[]) : null,
    loadPlanData(supabase, workspace.id, user.id, sender, now),
  ]);
  // every lead goes to the browser slim: the blocks skip closed ones, the "Analisar" counts match the Leads list, and
  // the setup dialog previews with the same builder
  const origins = sender ? await originListsOf(supabase, items.map((i) => i.lead.id)) : new Map();
  const rows: HomeRow[] = items.map((i) => {
    const r = toTableRow(i, origins.get(i.lead.id) ?? []);
    return {
      ...r,
      ai: undefined,
      best: r.best && ({ temperature: r.best.temperature, company_type: r.best.company_type, biggest_job_value_usd: r.best.biggest_job_value_usd } as typeof r.best),
      lead: { ...r.lead, do_not_call: i.lead.do_not_call },
    };
  });
  const { blocked, ...rest } = data;
  const input: PlanInput = { now: now.toISOString(), userId: user.id, sender, rows, ...rest, suppressed: suppressedOf(rows, blocked) };

  // what the "Ligar agora" settings can pick from: only leads that could ever be on that list
  const candidates = rows.filter((r) => stageOf(r.lead) === "new" && !r.lead.do_not_call);
  const countBy = (keys: (r: HomeRow) => string[]) => {
    const m = new Map<string, number>();
    for (const r of candidates) for (const k of keys(r)) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100).map(([k]) => k);
  };

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1080px] flex-col gap-[26px]">
      <HomeTabs current="plan" t={t} />
      <DayPlan
        input={input}
        plan={setup.plan}
        rule={setup.rule}
        dateLine={dateLineOf(now, t)}
        cities={countBy((r) => (r.display.city?.trim() ? [r.display.city.trim()] : []))}
        origins={countBy((r) => originKeysOf(r))}
        people={people}
      />
    </div>
  );
}
