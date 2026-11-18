import Link from "next/link";
import { EntryForm } from "@/components/hunt/EntryForm";
import { ProposalCard } from "@/components/hunt/ProposalCard";
import { startCampaignAction } from "../campanhas/actions";
import { Button, EmptyState, Field, HexPanel, Notice, StepTitle, TextArea, TextInput } from "@/components/ui";
import { proposeSearches } from "@/lib/hunt/proposals";
import { reduceCoverage, type CoverageRow } from "@/lib/kb/coverage";
import { getT } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";

type SP = { [k: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim().slice(0, 300) : "");

// First access: "quero mais clientes" -> 2-3 explained searches from the saved profile and the coverage on record.
export default async function WantMorePage({ searchParams }: { searchParams: Promise<SP> }) {
  const t = await getT();
  const P = t.hunt.proposals;
  const workspace = await requireSender();
  const sp = await searchParams;
  const q = one(sp.q);
  const erro = one(sp.erro);
  const db = await createClient();
  const { data: profile } = db ? await db.from("company_profiles").select("what_we_do, service_area, wanted_work, good_customer, not_wanted").eq("workspace_id", workspace.id).maybeSingle() : { data: null };
  const { data: cov } = db && q ? await db.rpc("kb_coverage", { p_ws: workspace.id }) : { data: null };
  const proposals = q ? proposeSearches(profile ?? {}, reduceCoverage((cov ?? []) as CoverageRow[])) : [];
  const needRegion = !String(profile?.service_area ?? "").trim();
  const error = erro in P.errors ? P.errors[erro as keyof typeof P.errors] : "";
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <HexPanel as="section" aria-labelledby="want-title" raised wrapClassName="k-in" className="flex flex-col gap-4 py-7">
        <h2 id="want-title" className="text-[28px] md:text-[32px]">{t.hunt.entry.title}</h2>
        <EntryForm q={q} />
      </HexPanel>

      {error && <Notice tone="warn" role="alert">{error}</Notice>}

      {q && (
        <section aria-labelledby="proposals-title" className="flex flex-col gap-5">
          <StepTitle as="h2" hint={P.intro}><span id="proposals-title">{P.title}</span></StepTitle>
          {proposals.length === 0 ? (
            <EmptyState title={P.none} action={<Link href="/configuracoes/empresa" className="k-link font-semibold underline">{P.profileLink}</Link>} />
          ) : (
            <>
              {proposals.map((p) => <ProposalCard key={p.offer} p={p} request={q} needRegion={needRegion} />)}
              <HexPanel as="section" aria-labelledby="other-title" className="flex flex-col gap-3 py-6" wrapClassName="k-in">
                <h3 id="other-title" className="m-0 font-body text-xl font-semibold normal-case tracking-normal">{P.otherTitle}</h3>
                <p className="m-0 text-base text-[#4a5361]">{P.otherHint}</p>
                <form action={startCampaignAction} className="flex max-w-xl flex-col gap-3">
                  <input type="hidden" name="offer" value={proposals[0].offer} />
                  <input type="hidden" name="kind" value="other" />
                  <Field label={P.otherLabel} htmlFor="other-request"><TextArea id="other-request" name="request" rows={3} maxLength={1000} required /></Field>
                  {needRegion && <Field label={P.regionLabel} htmlFor="other-region"><TextInput id="other-region" name="region" placeholder={P.regionPlaceholder} maxLength={200} /></Field>}
                  <div><Button type="submit" variant="secondary">{P.otherSubmit}</Button></div>
                </form>
              </HexPanel>
            </>
          )}
        </section>
      )}
    </div>
  );
}
