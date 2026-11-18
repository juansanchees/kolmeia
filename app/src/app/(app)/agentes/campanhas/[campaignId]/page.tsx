import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CampaignThread, type ThreadMessage, type ThreadRound } from "@/components/hunt/CampaignThread";
import { PreferenceCard, type PreferenceView } from "@/components/hunt/PreferenceCard";
import { Button, Field, HexPanel, Notice, TextArea } from "@/components/ui";
import { refreshPreference } from "@/lib/hunt/flow";
import { supabaseHuntDb } from "@/lib/hunt/db";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import type { CampaignParams } from "@/lib/offers/types";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { instructAction } from "../actions";

// The saved conversation of one campaign: your instructions, the Hunter's answers, one card per round, and the rules to approve.
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ campaignId: string }>; searchParams: Promise<{ erro?: string }> }) {
  const t = await getT();
  const H = t.hunt;
  const workspace = await requireSender();
  const { campaignId } = await params;
  const { erro } = await searchParams;
  const db = await createClient();
  if (!db || !z.string().uuid().safeParse(campaignId).success) notFound();
  const { data: c } = await db.from("hunt_campaigns").select("id, workspace_id, offer, region, params").eq("id", campaignId).maybeSingle();
  if (!c || c.workspace_id !== workspace.id) notFound();
  const campaign = { id: c.id as string, workspace_id: c.workspace_id as string, offer: c.offer as string, params: c.params as CampaignParams };
  // Proposing is idempotent (the same rule returns the same row, declined ones too); a failure is logged and must not hide the conversation.
  await refreshPreference(supabaseHuntDb(db), campaign).catch((e) => console.error("refreshPreference", e));

  const [messages, rounds, prefs, opps] = await Promise.all([
    db.from("hunt_messages").select("id, role, body, created_at").eq("campaign_id", campaignId).order("created_at"),
    db.from("hunt_rounds").select("id, n, ended_at, stop_reason, summary").eq("campaign_id", campaignId).order("n"),
    db.from("offer_preferences").select("id, status, rule, expected_effect, example_lead_ids").eq("workspace_id", workspace.id).eq("offer", c.offer).in("status", ["proposed", "approved"]).order("proposed_at"),
    db.from("lead_opportunities").select("lead_id, title").eq("campaign_id", campaignId).eq("status", "open"),
  ]);
  const title = new Map((opps.data ?? []).map((o) => [o.lead_id as string, String(o.title ?? "")]));
  const views: PreferenceView[] = (prefs.data ?? []).map((p) => ({
    id: p.id, status: p.status, rule: p.rule, expected_effect: p.expected_effect,
    examples: (p.example_lead_ids as string[]).map((l) => title.get(l)).filter((x): x is string => !!x).slice(0, 5),
  }));
  const error = erro === "empty" ? H.campaign.errors.empty : erro === "failed" ? H.campaign.errors.failed : "";
  const offerName = (H.campaign.offers as Record<string, string>)[c.offer] ?? c.offer;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link href="/agentes" className="k-link inline-flex min-h-11 w-fit items-center rounded-[10px] px-1 text-base font-medium underline">{H.campaign.back}</Link>
      <HexPanel as="section" aria-labelledby="campaign-title" raised wrapClassName="k-in" className="flex flex-col gap-3 py-7">
        <h2 id="campaign-title" className="text-[28px] md:text-[32px]">{fill(H.campaign.titleFor, { offer: offerName })}</h2>
        <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-2 text-base text-[#4a5361]">
          {c.region && <span>{H.campaign.region}: <span className="font-semibold text-ink">{c.region}</span></span>}
          <span>{fill(H.campaign.openOpps, { n: opps.data?.length ?? 0 })}</span>
          <Link href="/leads/ligar" className="k-link font-semibold underline">{H.campaign.queue}</Link>
        </p>
      </HexPanel>

      <section aria-labelledby="thread-title" className="flex flex-col gap-4">
        <h2 id="thread-title" className="text-2xl">{H.campaign.thread}</h2>
        <CampaignThread messages={(messages.data ?? []) as ThreadMessage[]} rounds={(rounds.data ?? []) as ThreadRound[]} />
      </section>

      {views.map((p) => <PreferenceCard key={p.id} campaignId={campaignId} pref={p} />)}

      {error && <Notice tone="warn" role="alert">{error}</Notice>}
      <HexPanel as="section" className="flex flex-col gap-3 py-6" wrapClassName="k-in">
        <form action={instructAction.bind(null, campaignId)} className="flex max-w-2xl flex-col gap-3">
          <Field label={H.campaign.next} htmlFor="instruction" hint={H.campaign.nextHint}>
            <TextArea id="instruction" name="instruction" rows={3} maxLength={1000} placeholder={H.campaign.placeholder} required />
          </Field>
          <div><Button type="submit">{H.campaign.send}</Button></div>
        </form>
      </HexPanel>
    </div>
  );
}
