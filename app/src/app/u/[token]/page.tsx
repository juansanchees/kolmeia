import type { Metadata } from "next";
import { isUnsubToken } from "@/lib/email/token";

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
    <main lang="en" className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-12">
      <section className="flex flex-col gap-4 border border-line bg-surface p-6">
        <h1 className="text-3xl">Unsubscribe</h1>
        {done ? (
          <p role="status" className="text-base">
            You are unsubscribed. You will not receive further e-mails from this sender. If one was already on its way, it
            may still arrive in the next few minutes.
          </p>
        ) : !valid ? (
          <p className="text-base">This unsubscribe link is not valid. Please reply to the e-mail with &quot;unsubscribe&quot; and the sender will remove you.</p>
        ) : (
          <>
            <p className="text-base">Click the button to stop receiving e-mails from this sender. No login is needed.</p>
            {failed && (
              <p role="alert" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
                Something went wrong on our side. Please try again in a minute.
              </p>
            )}
            <form method="post" action={`/api/unsubscribe/${token}?from=page`}>
              <button
                type="submit"
                className="inline-flex min-h-12 items-center border border-blue bg-blue px-5 text-[15px] font-semibold text-white hover:border-ink hover:bg-ink"
              >
                Unsubscribe me
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
