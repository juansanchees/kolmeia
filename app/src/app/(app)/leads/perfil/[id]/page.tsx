import { notFound } from "next/navigation";
import { Button, HexPanel, Notice, Select, StepTitle } from "@/components/ui";
import { ProfileCard } from "@/components/profile/ProfileCard";
import { isUuid } from "@/lib/profile/view";
import { getProfile, listHunters, profileBaseline } from "@/lib/profile/queries";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const pct = (x: number) => Math.round(x * 1000) / 10;

// Sender-only. Reading never applies anything: approving is a click on the card (a Server Action).
export default async function ProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const M = t.profile;
  const workspace = await requireSender();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  if (!supabase) notFound();
  const profile = await getProfile(supabase, id);
  if (!profile || profile.workspace_id !== workspace.id) notFound();
  const hunters = await listHunters(supabase, workspace.id);

  const q = (await searchParams).cacador;
  const agentId = typeof q === "string" && hunters.some((h) => h.id === q) ? q : null;
  const report = agentId ? await profileBaseline(supabase, profile, agentId).catch(() => null) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ProfileCard profile={profile} hunters={hunters} />
      <HexPanel as="section" aria-labelledby="compare-title" c={20} cSm={10} className="flex min-w-0 flex-col gap-4 py-6" wrapClassName="k-in [animation-delay:.22s]">
        <StepTitle n={profile.status === "proposed" ? 4 : 3} hint={M.compareHint}><span id="compare-title">{M.compareTitle}</span></StepTitle>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-[0_1_22rem] flex-col gap-1.5">
            <span className="font-mono text-[13px] font-medium uppercase tracking-wide">{M.compareHunter}</span>
            <Select name="cacador" defaultValue={agentId ?? ""}>
              <option value="" disabled>{M.compareChoose}</option>
              {hunters.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </Select>
          </label>
          <Button type="submit" variant="secondary">{M.compareRun}</Button>
        </form>
        {agentId && (report ? (
          <Notice tone="info">{fill(M.compareResult, { precision: pct(report.all.precision), coverage: pct(report.all.coverage), matched: report.all.matched, gold: report.all.gold })}</Notice>
        ) : (
          <Notice tone="info">{M.compareNone}</Notice>
        ))}
      </HexPanel>
    </div>
  );
}
