"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";

// Set by the list's company links: true only when this modal was opened from the list in this tab.
export const openedFromList = { value: false };

// Close = back when we came from the list (state and scroll stay); on a direct visit/reload, drop ?lead from the URL.
export function closeLead(router: { back(): void; replace(href: string, o?: { scroll: boolean }): void }, fromList: boolean, href: string) {
  if (fromList) {
    openedFromList.value = false;
    router.back();
  } else router.replace(href, { scroll: false });
}

export function LeadModal({ children }: { children: React.ReactNode }) {
  const t = useT();
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const params = new URLSearchParams(useSearchParams());
  params.delete("lead");
  const close = () => closeLead(router, openedFromList.value, `${pathname}${params.size ? `?${params}` : ""}`);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  // rounded, not a hexagon: the panel scrolls and holds selects and inline confirms that a clip-path would cut
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,27,61,0.45)] p-3 md:p-6" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-modal-title"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="k-in relative max-h-[92vh] w-full max-w-[980px] overflow-y-auto rounded-[20px] border border-[#e3e6ec] bg-ground p-4 pt-16 text-[17px] shadow-[0_24px_48px_-12px_rgba(15,27,61,0.45)] outline-none md:p-6 md:pt-16"
      >
        <button type="button" aria-label={t.leads.detail.close} onClick={close} className="k-close absolute right-3 top-3 inline-flex size-12 items-center justify-center rounded-full bg-surface text-ink">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {children}
      </div>
    </div>
  );
}
