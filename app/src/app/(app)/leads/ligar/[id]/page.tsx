import Link from "next/link";
import { notFound } from "next/navigation";
import { CallFacts } from "@/components/calls/CallFacts";
import { CallHistory } from "@/components/calls/CallHistory";
import { ContactRecord } from "@/components/calls/ContactRecord";
import { HexPanel, Notice } from "@/components/ui";
import { BlockTitle } from "@/components/leads/SectionIntro";
import { leadPhone } from "@/lib/calls/call-input";
import { callsOf } from "@/lib/calls/call-queries";
import { getLead } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";
import { topOpportunity } from "@/lib/hunt/top-opportunity";

// The call screen. Read as the user: RLS hides a lead that is not hers, so it is a 404.
export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const user = await getUser();
  if (!supabase || !user) notFound();
  const detail = await getLead(supabase, id);
  if (!detail) notFound();
  const best = detail.candidates.find((c) => c.id === detail.lead.best_candidate_id) ?? null;
  const phone = leadPhone(best?.phone, detail.fields);
  const [calls, opportunity] = await Promise.all([callsOf(supabase, id), topOpportunity(supabase, id)]);
  const blocked = detail.lead.do_not_call;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link href="/leads/ligar" className="k-link inline-flex min-h-11 w-fit items-center rounded-[10px] px-1 text-base font-medium underline">
        {t.calls.back}
      </Link>
      <CallFacts detail={detail} phone={phone} now={new Date()} blocked={blocked} opportunity={opportunity} />
      {blocked ? <Notice tone="warn" role="alert">{t.calls.blocked}</Notice> : (
        <HexPanel as="section" aria-label={t.calls.record.title} c={20} cSm={10} className="flex flex-col gap-4 py-6" wrapClassName="k-in [animation-delay:.15s]">
          <BlockTitle hint={t.calls.recordHint}>{t.calls.record.title}</BlockTitle>
          <ContactRecord leadId={id} afterSave="next" />
        </HexPanel>
      )}
      <CallHistory calls={calls} />
    </div>
  );
}
