import Link from "next/link";
import { EntryForm } from "./EntryForm";
import { CountPill, HexPanel } from "@/components/ui";
import { getT } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { fill } from "@/lib/i18n";

/** On the agents page: the "quero mais clientes" box and the searches already started (reopen the conversation). */
export async function HuntEntry({ workspaceId }: { workspaceId: string }) {
  const t = await getT();
  const E = t.hunt.entry;
  const db = await createClient();
  const { data } = db ? await db.from("hunt_campaigns").select("id, offer, region, updated_at").eq("workspace_id", workspaceId).order("updated_at", { ascending: false }).limit(20) : { data: null };
  const rows = data ?? [];
  return (
    <HexPanel as="section" aria-labelledby="hunt-entry" raised wrapClassName="k-in" className="flex flex-col gap-4 py-7">
      <h2 id="hunt-entry" className="text-2xl">{E.title}</h2>
      <EntryForm />
      {rows.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[#e3e6ec] pt-4">
          <h3 className="m-0 flex items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">{E.mine} <CountPill>{rows.length}</CountPill></h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/agentes/campanhas/${r.id}`} className="k-row flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[12px] px-3.5 py-2.5 text-ink no-underline">
                  <span className="min-w-0 font-semibold">{fill(t.hunt.campaign.titleFor, { offer: (t.hunt.campaign.offers as Record<string, string>)[r.offer] ?? r.offer })}</span>
                  <span className="text-[15px] text-[#4a5361]">{r.region ?? ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </HexPanel>
  );
}
