import Link from "next/link";
import { notFound } from "next/navigation";
import { LearnButton } from "@/components/profile/LearnButton";
import { resultsEstimateUsd } from "@/lib/ai/results-tasks";
import { learnBlock, resultCounts, type ResultsData } from "@/lib/learning/results";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill, t } from "@/messages/pt";

const R = t.profile.results;
type Row = { id: string; status: "approved" | "proposed"; version: number | null; source: "list" | "results"; created_at: string };

// Sender-only. The profiles in use and waiting, and "Aprender com os resultados". Reading changes nothing.
export default async function ProfilesPage() {
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
      <section aria-labelledby="profiles-title" className="flex min-w-0 flex-col gap-3 border border-line bg-surface p-5">
        <h1 id="profiles-title" className="text-2xl">{R.title}</h1>
        <p className="m-0 text-sm text-muted">{R.intro}</p>
        {approved.length === 0 && <p className="m-0 text-sm">{R.none}</p>}
        {approved.map((p) => (
          <p key={p.id} className="m-0 text-sm">
            {fill(R.current, { version: p.version ?? 0 })} · <Link href={`/leads/perfil/${p.id}`} className="text-blue underline underline-offset-4">{R.see}</Link>
          </p>
        ))}
        {proposed.map((p) => (
          <p key={p.id} className="m-0 text-sm font-semibold">
            {R.open} · <Link href={`/leads/perfil/${p.id}`} className="text-blue underline underline-offset-4">{R.see}</Link>
          </p>
        ))}
      </section>

      <section aria-labelledby="learn-title" className="flex min-w-0 flex-col gap-3 border border-line bg-surface p-5">
        <h2 id="learn-title" className="text-xl">{R.learnTitle}</h2>
        <p className="m-0 text-sm">{fill(R.counts, { labeled: c.labeled, positive: c.positive, negative: c.labeled - c.positive })}</p>
        <LearnButton estimateUsd={resultsEstimateUsd()} blocked={block ? R[block] : null} />
        <p className="m-0 text-[13px] text-muted">{R.auto}</p>
      </section>
    </div>
  );
}
