import { getCurrentWorkspace } from "@/lib/workspace";
import { settingsTabsFor } from "@/lib/nav";
import { SubNav } from "@/components/SubNav";
import { Notice, PageHeader } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

// Configurações (⚙ in the header): company profile, mailboxes, blocked list.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex min-w-0 flex-col gap-5 text-[17px]">
      <div className="flex flex-col gap-4">
        <PageHeader title={t.settings.title} subtitle={t.sources.settingsSubtitle} />
        <SubNav label={t.settings.nav.label} items={settingsTabsFor(workspace?.role ?? "closer", t)} />
      </div>
      {workspace?.role === "closer" && <Notice tone="info">{t.roles.closerNotice}</Notice>}
      {children}
    </div>
  );
}
