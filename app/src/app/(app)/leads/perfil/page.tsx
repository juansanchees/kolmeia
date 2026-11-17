import Link from "next/link";
import { notFound } from "next/navigation";
import { LearnButton } from "@/components/profile/LearnButton";
import { resultsEstimateUsd } from "@/lib/ai/results-tasks";
import { learnBlock, resultCounts, type ResultsData } from "@/lib/learning/results";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import { SectionIntro } from "@/components/leads/SectionIntro";
import { Badge, buttonClass, Chevron, HexPanel, StepTitle } from "@/components/ui";

type Row = { id: string; status: "approved" | "proposed"; version: number | null; source: "list" | "results"; created_at: string };

// Sender-only. The profiles in use and waiting, and "Aprender com os resultados". Reading changes nothing.
export default async function ProfilesPage() {
  const t = await getT();
  const R = t.profile.results;
  const workspace = await requireSender();
  const db = await createClient();
  if (!db) notFound();
  const [results, list] = await Promise.all([
    db.rpc("results_learning_rows", { p_ws: workspace.id }),
    db.from("learned_profiles").select("id, status, version, source, created_at").eq("workspace_id", workspace.id).in("status", ["approved", "proposed"]).order("created_at", { ascending: false }).limit(20),
  ]);
  const rows = (results.data as ResultsData | null)?.rows ?? [];
  const c = resultCounts(rows);
  const block = learnBlock(c);
  const profiles = (list.data ?? []) as Row[];
  const approved = profiles.filter((p) => p.status === "approved");
  const proposed = profiles.filter((p) => p.status === "proposed");

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SectionIntro id="profiles-title" title={R.title} subtitle={R.intro} />

      <HexPanel as="section" aria-labelledby="inuse-title" c={20} cSm={10} className="flex min-w-0 flex-col gap-4 py-6" wrapClassName="k-in [animation-delay:.15s]">
        <StepTitle n={1}><span id="inuse-title">{t.profile.inUseTitle}</span></StepTitle>
        {approved.length === 0 && <p className="m-0 text-base text-[#4a5361]">{R.none}</p>}
        {(approved.length > 0 || proposed.length > 0) && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {proposed.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3">
                <span className="text-base font-semibold">{R.open}</span>
                <Link href={`/leads/perfil/${p.id}`} className={buttonClass("primary", "sm")}>{R.see} <Chevron size={16} className="k-arrow" /></Link>
              </li>
            ))}
            {approved.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-ground px-4 py-3">
                <span className="flex items-center gap-2 text-base">
                  <Badge tone="ok">{fill(R.current, { version: p.version ?? 0 })}</Badge>
                </span>
                <Link href={`/leads/perfil/${p.id}`} className={buttonClass("secondary", "sm")}>{R.see}</Link>
              </li>
            ))}
          </ul>
        )}
      </HexPanel>

      <HexPanel as="section" aria-labelledby="learn-title" c={20} cSm={10} className="flex min-w-0 flex-col gap-4 py-6" wrapClassName="k-in [animation-delay:.22s]">
        <StepTitle n={2} hint={fill(R.counts, { labeled: c.labeled, positive: c.positive, negative: c.labeled - c.positive })}><span id="learn-title">{R.learnTitle}</span></StepTitle>
        <LearnButton estimateUsd={resultsEstimateUsd()} blocked={block ? R[block] : null} />
        <p className="m-0 text-[15px] text-[#4a5361]">{R.auto}</p>
      </HexPanel>
    </div>
  );
}
