import { redirect } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { PublicShell } from "@/components/ui";
import { safeNext } from "./next";
import { LoginForm } from "./LoginForm";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = safeNext((await searchParams).next);
  if (!hasSupabase) return <NotConfigured />;
  if (await getUser()) redirect(next);
  return (
    <PublicShell aside={<LocaleSwitch />}>
      <LoginForm next={next} />
    </PublicShell>
  );
}
