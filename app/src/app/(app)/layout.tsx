import { redirect } from "next/navigation";
import { hasSupabase } from "@/lib/env";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { NotConfigured } from "@/components/NotConfigured";
import { Header } from "@/components/Header";
import { NavLinks } from "@/components/NavLinks";

// Session-dependent: never prerender.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!hasSupabase) return <NotConfigured />;
  if (!(await getUser())) redirect("/login");
  const workspace = await getCurrentWorkspace();
  if (!workspace) redirect("/onboarding");
  return (
    <>
      <Header workspaceName={workspace.name} role={workspace.role} />
      <main className="mx-auto max-w-6xl px-4 pt-8 pb-24 md:pb-8">{children}</main>
      <NavLinks variant="bottom" role={workspace.role} />
    </>
  );
}
