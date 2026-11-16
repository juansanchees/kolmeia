"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// Close = back, so the list keeps its page, filters and scroll. No history (new tab): go to the list.
export function closeLead(router: { back(): void; push(href: string): void }, historyLength: number) {
  if (historyLength > 1) router.back();
  else router.push("/leads");
}

export function LeadModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const close = () => closeLead(router, window.history.length);

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
