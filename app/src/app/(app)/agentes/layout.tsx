import Link from "next/link";
import { getCurrentWorkspace } from "@/lib/workspace";
import { isSender } from "@/lib/roles";
import { getT } from "@/lib/i18n/server";

export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl">{t.agents.title}</h1>
        {workspace && isSender(workspace.role) && (
          <Link
            href="/agentes/novo"
            className="inline-flex min-h-11 items-center border border-blue bg-blue px-4 text-[15px] font-semibold text-white no-underline hover:border-ink hover:bg-ink"
          >
            {t.agents.newAgent}
          </Link>
        )}
      </header>
      {children}
    </div>
  );
}
