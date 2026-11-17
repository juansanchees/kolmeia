import { redirect } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { PublicShell } from "@/components/ui";
import { OnboardingForm } from "./OnboardingForm";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  if (!hasSupabase) return <NotConfigured />;
  if (!(await getUser())) redirect("/login");
  if (await getCurrentWorkspace()) redirect("/");
  return (
    <PublicShell aside={<LocaleSwitch />}>
      <OnboardingForm />
    </PublicShell>
  );
}
