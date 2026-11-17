import { getCurrentWorkspace } from "@/lib/workspace";
import { leadsCards, leadsMoreLinks } from "@/lib/nav";
import { LeadsNav } from "@/components/leads/LeadsNav";
import { Notice } from "@/components/email/bits";
import { getT } from "@/lib/i18n/server";

// LEADS: every company the searches found, once each, and the ones handed to the closer.
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex min-w-0 flex-col gap-5 text-[17px]">
      <div className="flex flex-col gap-4">
        <header className="k-in flex flex-col gap-1.5">
          <h1 className="text-4xl md:text-[46px]">{t.leads.title}</h1>
          <p className="m-0 text-lg text-[#4a5361]">{t.leads.subtitle}</p>
        </header>
        <LeadsNav label={t.leads.nav.label} cards={leadsCards(t)} more={leadsMoreLinks(workspace?.role ?? "closer", t)} moreLabel={t.leads.nav.more.label} />
      </div>
      {workspace?.role === "closer" && <Notice tone="info">{t.roles.closerNotice}</Notice>}
      {children}
    </div>
  );
}
