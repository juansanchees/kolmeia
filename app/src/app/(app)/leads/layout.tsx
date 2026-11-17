import { getCurrentWorkspace } from "@/lib/workspace";
import { leadsTabs, leadsTabsFor } from "@/lib/nav";
import { SubNav } from "@/components/SubNav";
import { Notice } from "@/components/email/bits";
import { getT } from "@/lib/i18n/server";

// LEADS: every company the searches found, once each, and the ones handed to the closer.
export default async function LeadsLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h1 className="text-4xl">{t.leads.title}</h1>
          <p className="text-muted">{t.leads.subtitle}</p>
        </header>
        <SubNav label={t.leads.nav.label} items={workspace ? leadsTabsFor(workspace.role, t) : leadsTabs(t)} />
      </div>
      {workspace?.role === "closer" && <Notice tone="info">{t.roles.closerNotice}</Notice>}
      {children}
    </div>
  );
}
