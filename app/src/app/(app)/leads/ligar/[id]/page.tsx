import Link from "next/link";
import { notFound } from "next/navigation";
import { CallFacts } from "@/components/calls/CallFacts";
import { CallForm } from "@/components/calls/CallForm";
import { CallHistory } from "@/components/calls/CallHistory";
import { Notice } from "@/components/email/bits";
import { leadPhone } from "@/lib/calls/call-input";
import { agentOfToday, callsOf } from "@/lib/calls/call-queries";
import { getLead } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/workspace";
import { t } from "@/messages/pt";

// The call screen. Read as the user: RLS hides a lead that is not hers, so it is a 404.
export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const user = await getUser();
  if (!supabase || !user) notFound();
  const detail = await getLead(supabase, id);
  if (!detail) notFound();
  const best = detail.candidates.find((c) => c.id === detail.lead.best_candidate_id) ?? null;
  const phone = leadPhone(best?.phone, detail.fields);
  const [calls, agentId] = await Promise.all([callsOf(supabase, id), agentOfToday(supabase, user.id, id)]);
  const blocked = detail.lead.do_not_call;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Link href="/leads/ligar" className="font-mono text-xs text-blue underline underline-offset-4">
        {t.calls.back}
      </Link>
      <CallFacts detail={detail} phone={phone} now={new Date()} blocked={blocked} />
      {blocked ? <Notice tone="warn" role="alert">{t.calls.blocked}</Notice> : <CallForm leadId={id} agentId={agentId} status={detail.lead.status} />}
      <CallHistory calls={calls} />
    </div>
  );
}
