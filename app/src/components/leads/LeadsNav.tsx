"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHref, type LeadsCard, type NavItem } from "@/lib/nav";

const ICONS: Record<LeadsCard["icon"], string> = {
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  phone:
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  check: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
};

/** LEADS navigation: four hexagon cards (every role) and a small "Organizar e analisar" row (owner and sdr). */
export function LeadsNav({ label, cards, more, moreLabel }: { label: string; cards: readonly LeadsCard[]; more: readonly NavItem[]; moreLabel: string }) {
  // the longest match over cards AND links, so /leads/listas lights Listas, not "Todos os leads"
  const active = activeHref(usePathname(), [...cards, ...more].map((i) => i.href));
  return (
    <>
      <nav aria-label={label} className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
        {cards.map((c, n) => {
          const on = c.href === active;
          return (
            <Link
              key={c.href}
              href={c.href}
              aria-current={on ? "page" : undefined}
              style={{ animationDelay: `${0.06 + n * 0.05}s` }}
              className={`k-lift k-in block text-ink no-underline ${on ? "drop-shadow-[0_12px_14px_rgba(15,27,61,0.28)]" : "drop-shadow-[0_1px_1px_rgba(15,27,61,0.06)]"}`}
            >
              <span className={`hx block h-full p-[2px] [--c:14px] ${on ? "bg-honey" : "bg-[#e3e6ec]"}`}>
                <span className={`hx ${on ? "" : "hx-fill"} flex h-full min-h-[100px] items-center gap-3.5 py-4 pl-[26px] pr-6 [--c:13.4px] ${on ? "bg-ink text-white" : "bg-surface text-ink"}`}>
                  <span className={`hxv inline-flex h-[50px] w-11 shrink-0 items-center justify-center text-ink ${on ? "bg-honey" : "bg-honey-soft"}`}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d={ICONS[c.icon]} />
                    </svg>
                  </span>
                  <span className="flex flex-col gap-1">
                    <span className="text-[19px] font-semibold">{c.label}</span>
                    <span className={`text-[15px] ${on ? "text-honey-glow" : "text-[#4a5361]"}`}>{c.hint}</span>
                  </span>
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
      {more.length > 0 && (
        <nav aria-label={moreLabel} className="k-in flex flex-wrap items-center gap-x-1 gap-y-1.5 text-base [animation-delay:.25s]">
          <span className="mr-1.5 text-[#4a5361]">{moreLabel}</span>
          {more.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={l.href === active ? "page" : undefined}
              className={`k-link inline-flex min-h-11 items-center rounded-[10px] px-2.5 underline ${l.href === active ? "font-bold" : "font-medium"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
