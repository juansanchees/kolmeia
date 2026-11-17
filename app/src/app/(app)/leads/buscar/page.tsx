import Link from "next/link";
import { RunHistory } from "@/components/sources/RunHistory";
import { SearchForm } from "@/components/sources/SearchForm";
import { connectedSources, listRuns } from "@/lib/sources/queries";
import { todayLine } from "@/lib/sources/view";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";
import { SectionIntro } from "@/components/leads/SectionIntro";
import { buttonClass, Chevron, EmptyState } from "@/components/ui";

const SEARCH_ICON = "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5";

// Sender-only (the closer is sent back to LEADS). Forms show only for connected sources; reads run as the user.
export default async function SearchPage() {
  const t = await getT();
  const Q = t.sources.search;
  const workspace = await requireSender();
  const supabase = await createClient();
  const conn = supabase ? await connectedSources(supabase, workspace.id) : null;
  const runs = supabase ? await listRuns(supabase, workspace.id) : [];
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <section aria-labelledby="buscar-title" className="flex flex-col gap-4">
        <SectionIntro id="buscar-title" title={Q.title} subtitle={Q.intro} />
        {conn && (conn.maps || conn.apollo || conn.shovels || conn.rapidapi) ? (
          <>
            <ul className="k-in m-0 flex list-none flex-wrap gap-2 p-0 [animation-delay:.15s]">
              {conn.maps && <li className="rounded-full bg-honey-soft px-3.5 py-1.5 font-mono text-sm">{t.sources.providers.apify}: {todayLine({ provider: "apify", today: conn.today.apify.spent, cap: conn.today.apify.cap }, t)}</li>}
              {conn.apollo && <li className="rounded-full bg-honey-soft px-3.5 py-1.5 font-mono text-sm">{t.sources.providers.apollo}: {todayLine({ provider: "apollo", today: conn.today.apollo.calls, cap: conn.today.apollo.cap }, t)}</li>}
              {conn.shovels && <li className="rounded-full bg-honey-soft px-3.5 py-1.5 font-mono text-sm">{t.sources.providers.shovels}: {todayLine({ provider: "shovels", today: conn.month.shovels.used, cap: conn.month.shovels.cap }, t)}</li>}
              {conn.rapidapi && (
                <li className="rounded-full bg-honey-soft px-3.5 py-1.5 font-mono text-sm">
                  {t.sources.providers.rapidapi}: {todayLine({ provider: "rapidapi", today: conn.month.rapidapi.calls, cap: conn.month.rapidapi.callsCap }, t)} ·{" "}
                  {todayLine({ provider: "rapidapi_sites", today: conn.month.rapidapi.sites, cap: conn.month.rapidapi.sitesCap }, t)}
                </li>
              )}
            </ul>
            <div className="k-in flex flex-wrap items-start gap-5 [animation-delay:.22s]">
              {conn.maps && <SearchForm kind="maps" />}
              {conn.apollo && <SearchForm kind="apollo" />}
              {conn.shovels && <SearchForm kind="shovels" />}
              {conn.rapidapi && <SearchForm kind="b2b" />}
            </div>
          </>
        ) : (
          <EmptyState
            icon={SEARCH_ICON}
            title={Q.noneConnected}
            action={
              <Link href="/configuracoes/fontes" className={buttonClass("primary")}>
                {Q.connectLink} <Chevron size={16} className="k-arrow" />
              </Link>
            }
          />
        )}
      </section>
      <RunHistory runs={runs} />
    </div>
  );
}
