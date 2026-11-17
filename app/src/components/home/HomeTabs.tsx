import Link from "next/link";
import type { Messages } from "@/lib/i18n";

export const CAL = "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z";

/** "Plano de hoje" | "Agenda" (links, aria-current). */
export function HomeTabs({ current, t }: { current: "plan" | "agenda"; t: Messages }) {
  const tab = (on: boolean) =>
    `k-btn inline-flex min-h-12 items-center gap-2 rounded-[12px] px-[22px] no-underline ${on ? "bg-ink font-semibold text-white" : "font-medium text-ink hover:bg-surface"}`;
  return (
    <nav aria-label={t.home.tabs.label} className="k-in inline-flex self-start gap-[5px] rounded-[16px] bg-[#e9ecf1] p-[5px]">
      <Link href="/inicio" aria-current={current === "plan" ? "page" : undefined} className={tab(current === "plan")}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path className={current === "plan" ? "fill-honey" : "fill-current"} d="M12 2 20.7 7v10L12 22 3.3 17V7Z" /></svg>
        {t.home.tabs.plan}
      </Link>
      <Link href="/inicio/agenda" aria-current={current === "agenda" ? "page" : undefined} className={tab(current === "agenda")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className={current === "agenda" ? "text-honey" : ""}><path d={CAL} /></svg>
        {t.home.tabs.agenda}
      </Link>
    </nav>
  );
}

