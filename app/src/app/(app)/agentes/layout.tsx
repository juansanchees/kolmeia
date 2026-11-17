import Link from "next/link";
import { getCurrentWorkspace } from "@/lib/workspace";
import { isSender } from "@/lib/roles";
import { buttonClass, PageHeader } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  const workspace = await getCurrentWorkspace();
  return (
    <div className="flex min-w-0 flex-col gap-6 text-[17px]">
      <PageHeader
        title={t.agents.title}
        subtitle={t.agents.subtitle}
        actions={
          workspace &&
          isSender(workspace.role) && (
            <Link href="/agentes/novo" className={buttonClass("secondary")}>
              {t.agents.newAgent}
            </Link>
          )
        }
      />
      {children}
    </div>
  );
}
