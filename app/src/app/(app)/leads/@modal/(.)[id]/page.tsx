import { LeadDetail } from "@/components/leads/LeadDetail";
import { LeadModal } from "@/components/leads/LeadModal";

export const maxDuration = 300;

// Soft navigation to /leads/[id] lands here: same detail, drawn over the list. Reload/direct visit uses [id]/page.tsx.
export default async function LeadModalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // /leads/closer, /leads/ligar... also match [id]: only real lead ids open the modal (the page renders normally).
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (
    <LeadModal>
      <LeadDetail id={id} modal />
    </LeadModal>
  );
}
