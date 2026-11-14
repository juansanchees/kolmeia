import Link from "next/link";
import { Notice } from "@/components/email/bits";
import { RunHistory } from "@/components/sources/RunHistory";
import { SearchForm } from "@/components/sources/SearchForm";
import { connectedSources, listRuns } from "@/lib/sources/queries";
import { todayLine } from "@/lib/sources/view";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const Q = t.sources.search;

// Sender-only (the closer is sent back to LEADS). Forms show only for connected sources; reads run as the user.
export default async function SearchPage() {
  const workspace = await requireSender();
  const supabase = await createClient();
  const conn = supabase ? await connectedSources(supabase, workspace.id) : null;
  const runs = supabase ? await listRuns(supabase, workspace.id) : [];
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <section aria-labelledby="buscar-title" className="flex flex-col gap-3">
        <h2 id="buscar-title" className="text-2xl">{Q.title}</h2>
        <p className="text-sm">{Q.intro}</p>
        {conn && (conn.maps || conn.apollo) ? (
          <>
            <div className="flex flex-col gap-1 font-mono text-xs text-muted">
              {conn.maps && <span>{t.sources.providers.apify}: {todayLine({ provider: "apify", today: conn.today.apify.spent, cap: conn.today.apify.cap })}</span>}
              {conn.apollo && <span>{t.sources.providers.apollo}: {todayLine({ provider: "apollo", today: conn.today.apollo.calls, cap: conn.today.apollo.cap })}</span>}
            </div>
            <div className="flex flex-wrap items-start gap-5">
              {conn.maps && <SearchForm kind="maps" />}
              {conn.apollo && <SearchForm kind="apollo" />}
            </div>
          </>
        ) : (
          <>
            <Notice tone="info">{Q.noneConnected}</Notice>
            <div>
              <Link href="/configuracoes/fontes" className="text-sm text-blue underline underline-offset-4">{Q.connectLink}</Link>
            </div>
          </>
        )}
      </section>
      <RunHistory runs={runs} />
    </div>
  );
}
