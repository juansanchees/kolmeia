import { redirect } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { safeNext } from "./next";
import { LoginForm } from "./LoginForm";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = safeNext((await searchParams).next);
  if (!hasSupabase) return <NotConfigured />;
  if (await getUser()) redirect(next);
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="mb-6 flex justify-end">
        <LocaleSwitch />
      </div>
      <LoginForm next={next} />
    </main>
  );
}
