import { notFound } from "next/navigation";
import { Notice } from "@/components/email/bits";
import { ProfileCard } from "@/components/profile/ProfileCard";
import { getProfile, listHunters, profileBaseline } from "@/lib/profile/queries";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill, t } from "@/messages/pt";

const M = t.profile;
const UUID = /^[0-9a-f-]{36}$/i;
const pct = (x: number) => Math.round(x * 1000) / 10;

// Sender-only. Reading never applies anything: approving is a click on the card (a Server Action).
export default async function ProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const workspace = await requireSender();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  if (!supabase) notFound();
  const profile = await getProfile(supabase, id);
  if (!profile || profile.workspace_id !== workspace.id) notFound();
  const hunters = await listHunters(supabase, workspace.id);

  const q = (await searchParams).caçador;
  const agentId = typeof q === "string" && hunters.some((h) => h.id === q) ? q : null;
  const report = agentId ? await profileBaseline(supabase, profile, agentId).catch(() => null) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <ProfileCard profile={profile} hunters={hunters} />
      <section aria-labelledby="compare-title" className="flex min-w-0 flex-col gap-3 border border-line bg-surface p-5">
        <h2 id="compare-title" className="text-xl">{M.compareTitle}</h2>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            {M.compareHunter}
            <select name="caçador" defaultValue={agentId ?? ""} className="w-full min-w-0 border border-line bg-surface px-3 py-2 text-base text-ink">
              <option value="" disabled>{M.compareChoose}</option>
              {hunters.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </label>
          <button type="submit" className="inline-flex min-h-11 items-center justify-center border border-edge bg-surface px-4 text-[15px] font-medium text-ink hover:border-ink">{M.compareRun}</button>
        </form>
        {agentId && (report ? (
          <Notice tone="info">{fill(M.compareResult, { precision: pct(report.all.precision), coverage: pct(report.all.coverage), matched: report.all.matched, gold: report.all.gold })}</Notice>
        ) : (
          <Notice tone="info">{M.compareNone}</Notice>
        ))}
      </section>
    </div>
  );
}
