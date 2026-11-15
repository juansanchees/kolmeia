import Link from "next/link";
import { notFound } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { t } from "@/messages/pt";
import { AcceptButton } from "./AcceptButton";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  if (!hasSupabase) return <NotConfigured />;

  const user = await getUser();
  let body: React.ReactNode;
  if (!user) {
    // invite_preview needs a session, so the invite e-mail is unknown here and the prompt is generic.
    body = (
      <>
        <p>{t.team.signInFirstGeneric}</p>
        <Link href={`/login?next=/convite/${token}`} className="text-blue underline underline-offset-4">
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
        <p>{t.team.joinAs.replace("{workspace}", row.workspace_name)}</p>
        <p className="break-all text-sm">{row.email}</p>
        <AcceptButton token={token} />
      </>
    ) : (
      <p role="alert" className="text-danger">{t.team.expired}</p>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="flex flex-col gap-4 border border-line bg-surface p-6">
        <h1 className="text-3xl">{t.team.joinTitle}</h1>
        {body}
      </div>
    </main>
  );
}
