"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-modal-title"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="relative max-h-[90vh] w-full max-w-[960px] overflow-y-auto border border-line bg-ground p-4 pt-12 outline-none"
      >
        <button type="button" aria-label="Fechar" onClick={close} className="absolute right-2 top-2 inline-flex size-9 items-center justify-center border border-line bg-surface text-lg leading-none">
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
