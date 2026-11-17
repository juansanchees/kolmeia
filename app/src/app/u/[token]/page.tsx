import type { Metadata } from "next";
import { isUnsubToken } from "@/lib/email/token";
import { HexButton, Notice, PublicShell } from "@/components/ui";

// Public page for e-mail recipients (US companies), so it is in English. Logged out; it reads nothing about the
// recipient. Opening it changes nothing: the button POSTs to /api/unsubscribe/[token] (idempotent).

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const valid = isUnsubToken(token);
  const done = sp.done === "1";
  const failed = sp.error === "1";

  return (
    <PublicShell lang="en" logo={false}>
        <h1 className="text-4xl">Unsubscribe</h1>
        {done ? (
          <p role="status" className="m-0 text-lg">
            You are unsubscribed. You will not receive further e-mails from this sender. If one was already on its way, it
            may still arrive in the next few minutes.
          </p>
        ) : !valid ? (
          <p className="m-0 text-lg">This unsubscribe link is not valid. Please reply to the e-mail with &quot;unsubscribe&quot; and the sender will remove you.</p>
        ) : (
          <>
            <p className="m-0 text-lg">Click the button to stop receiving e-mails from this sender. No login is needed.</p>
            {failed && (
              <Notice tone="warn" role="alert">
                Something went wrong on our side. Please try again in a minute.
              </Notice>
            )}
            <form method="post" action={`/api/unsubscribe/${token}?from=page`}>
              <HexButton type="submit">Unsubscribe me</HexButton>
            </form>
          </>
        )}
    </PublicShell>
  );
}
