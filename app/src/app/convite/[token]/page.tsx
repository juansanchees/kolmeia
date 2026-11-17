import Link from "next/link";
import { notFound } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { buttonClass, Notice, PublicShell } from "@/components/ui";
import { getT } from "@/lib/i18n/server";
import { AcceptButton } from "./AcceptButton";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getT();
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  if (!hasSupabase) return <NotConfigured />;

  const user = await getUser();
  let body: React.ReactNode;
  if (!user) {
    // invite_preview needs a session, so the invite e-mail is unknown here and the prompt is generic.
    body = (
      <>
        <p className="m-0 text-lg">{t.team.signInFirstGeneric}</p>
        <Link href={`/login?next=/convite/${token}`} className={`${buttonClass("primary")} min-h-14! text-[17px]!`}>
          {t.login.signIn}
        </Link>
      </>
    );
  } else {
    const supabase = await createClient();
    const { data } = (await supabase?.rpc("invite_preview", { p_token: token })) ?? { data: null };
    const row = (Array.isArray(data) ? data[0] : data) as { workspace_name: string; email: string; valid: boolean } | null | undefined;
    // "No row" = unknown token = expired.
    body = row?.valid ? (
      <>
        <p className="m-0 text-lg">{t.team.joinAs.replace("{workspace}", row.workspace_name)}</p>
        <p className="m-0 break-all rounded-[12px] bg-cold px-3.5 py-2.5 font-mono text-[15px]">{row.email}</p>
        <AcceptButton token={token} />
      </>
    ) : (
      <Notice tone="danger" role="alert">{t.team.expired}</Notice>
    );
  }

  return (
    <PublicShell aside={<LocaleSwitch />}>
      <h1 className="text-4xl">{t.team.joinTitle}</h1>
      {body}
    </PublicShell>
  );
}
