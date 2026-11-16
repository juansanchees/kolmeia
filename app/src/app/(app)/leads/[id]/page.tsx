import { LeadDetail } from "@/components/leads/LeadDetail";

// "Checar e-mails" / "Achar e-mail" run from here too (DNS look-ups): give the server actions time.
export const maxDuration = 300;

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  return <LeadDetail id={(await params).id} />;
}
