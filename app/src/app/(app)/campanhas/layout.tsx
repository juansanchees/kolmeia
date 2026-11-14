import { requireSender } from "@/lib/workspace";
import { SubNav } from "@/components/SubNav";
import { CAMPAIGN_TABS } from "@/lib/nav";
import { t } from "@/messages/pt";

// The Campanhas de e-mail area: its own sub-navigation, separate from Pesquisa (connected only by the approved lists).
export default async function CampaignsLayout({ children }: { children: React.ReactNode }) {
  await requireSender();
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-4xl">{t.email.title}</h1>
          <p className="m-0 text-base text-muted">{t.email.overview.subtitle}</p>
        </div>
        <SubNav label={t.email.nav.label} items={CAMPAIGN_TABS} />
      </div>
      {children}
    </div>
  );
}
