import { requireSender } from "@/lib/workspace";
import { emailSession } from "@/lib/email/session";
import { SubNav } from "@/components/SubNav";
import { ActionButton } from "@/components/email/ActionButton";
import { CampaignWarnings } from "@/components/email/CampaignWarnings";
import { when } from "@/components/email/format";
import { CAMPAIGN_TABS } from "@/lib/nav";
import { setSendingPaused } from "./actions";
import { fill, t } from "@/messages/pt";

const S = t.email.stop;

// The Campanhas de e-mail area: its own sub-navigation, separate from Pesquisa (connected only by the approved lists).
// E4: the emergency stop lives in the header, on every Campanhas page.
export default async function CampaignsLayout({ children }: { children: React.ReactNode }) {
  const workspace = await requireSender();
  const s = await emailSession();
  const { data } = s
    ? await s.supabase.from("workspace_settings").select("sending_paused, sending_paused_at").eq("workspace_id", workspace.id).maybeSingle()
    : { data: null };
  const paused = (data as { sending_paused: boolean; sending_paused_at: string | null } | null) ?? { sending_paused: false, sending_paused_at: null };
  const isOwner = workspace.role === "owner";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-4xl">{t.email.title}</h1>
            <p className="m-0 text-base text-muted">{t.email.overview.subtitle}</p>
          </div>
          {!paused.sending_paused && <ActionButton action={setSendingPaused.bind(null, true)} label={S.button} variant="danger" confirm={S.confirm} />}
        </div>
        {paused.sending_paused && (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="m-0 bg-warn-soft px-3 py-2.5 text-sm font-semibold text-warn">{fill(S.paused, { when: when(paused.sending_paused_at) })}</p>
            {isOwner ? (
              <ActionButton action={setSendingPaused.bind(null, false)} label={S.resume} confirm={S.resumeConfirm} />
            ) : (
              <span className="text-sm text-muted">{S.onlyOwner}</span>
            )}
          </div>
        )}
        {s && <CampaignWarnings db={s.supabase} workspaceId={workspace.id} />}
        <SubNav label={t.email.nav.label} items={CAMPAIGN_TABS} />
      </div>
      {children}
    </div>
  );
}
