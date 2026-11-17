import { redirect } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { LocaleSwitch } from "@/components/LocaleSwitch";
import { OnboardingForm } from "./OnboardingForm";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  if (!hasSupabase) return <NotConfigured />;
  if (!(await getUser())) redirect("/login");
  if (await getCurrentWorkspace()) redirect("/");
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <div className="mb-6 flex justify-end">
        <LocaleSwitch />
      </div>
      <OnboardingForm />
    </main>
  );
}
