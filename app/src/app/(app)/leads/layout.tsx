import { getCurrentWorkspace } from "@/lib/workspace";
import { LEADS_TABS } from "@/lib/nav";
import { SubNav } from "@/components/SubNav";
import { Notice } from "@/components/email/bits";
import { t } from "@/messages/pt";

// LEADS: every company the searches found, once each, and the ones handed to the closer.
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h1 className="text-4xl">{t.leads.title}</h1>
          <p className="text-muted">{t.leads.subtitle}</p>
        </header>
        <SubNav label={t.leads.nav.label} items={LEADS_TABS} />
      </div>
      {workspace?.role === "closer" && <Notice tone="info">{t.roles.closerNotice}</Notice>}
      {children}
    </div>
  );
}
