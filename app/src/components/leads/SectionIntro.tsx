import type { ReactNode } from "react";
import { HexIcon } from "@/components/ui";

/** The heading of a page inside LEADS (the layout already has the h1): an h2 + one plain line + optional actions. */
export function SectionIntro({ id, title, subtitle, actions }: { id?: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="k-in flex flex-wrap items-end justify-between gap-3 [animation-delay:.1s]">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={id} className="text-[28px] md:text-[32px]">{title}</h2>
        {subtitle && <p className="m-0 text-base text-[#4a5361] md:text-lg">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

/** The title of a block (card or panel) inside a LEADS page: a small honey hexagon + an h2 (or h3) + an optional plain line. */
export function BlockTitle({ id, children, hint, as: Tag = "h2" }: { id?: string; children: ReactNode; hint?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <div className="flex flex-col gap-1">
      <Tag id={id} className="m-0 flex items-center gap-2.5 font-body text-xl font-semibold normal-case tracking-normal">
        <HexIcon size={22} />
        {children}
      </Tag>
      {hint && <p className="m-0 pl-[32px] text-base text-[#4a5361]">{hint}</p>}
    </div>
  );
}
