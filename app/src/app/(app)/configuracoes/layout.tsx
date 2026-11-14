import { getCurrentWorkspace } from "@/lib/workspace";
import { SETTINGS_TABS } from "@/lib/nav";
import { SubNav } from "@/components/SubNav";
import { Notice } from "@/components/email/bits";
import { t } from "@/messages/pt";

// Configurações (⚙ in the header): company profile, mailboxes, blocked list.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl">{t.settings.title}</h1>
        <SubNav label={t.settings.nav.label} items={SETTINGS_TABS} />
      </div>
      {workspace?.role === "closer" && <Notice tone="info">{t.roles.closerNotice}</Notice>}
      {children}
    </div>
  );
}
