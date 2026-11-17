"use client";

import { useEffect, useRef } from "react";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";
import { Chevron } from "@/components/leads/hex";

/**
 * "Mais filtros" as a native modal <dialog> from the right: Esc and X close it, focus moves in on open and the browser
 * returns it to the opener on close. Full screen on a phone. The panel content (FacetPanel) mounts only while open.
 */
export function FilterDialog({ open, onClose, n, onClear, children }: { open: boolean; onClose: () => void; n: number; onClear: () => void; children: React.ReactNode }) {
  const t = useT();
  const P = t.leads.panel;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      id="lead-filters"
      aria-labelledby="lead-filters-title"
      onClose={onClose}
      // a click on the backdrop (the dialog box itself, outside the panel) closes it
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="k-panel fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 text-[17px] text-ink md:left-auto md:w-[min(780px,100vw)] md:py-3 md:pr-3"
    >
      <div className="h-full md:drop-shadow-[0_16px_28px_rgba(15,27,61,0.25)]">
        <div className="h-full bg-line md:hx md:p-[1.5px] md:[--c:26px]">
          <div className="flex h-full flex-col bg-surface md:hx md:[--c:25.4px]">
            <div className="flex items-start justify-between gap-4 border-b border-[#e3e6ec] py-5 pl-5 pr-4 md:pt-6 md:pl-10 md:pr-9">
              <div className="flex items-start gap-3.5">
                <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden className="mt-0.5 shrink-0">
                  <path className="fill-honey stroke-honey" strokeWidth="1.6" strokeLinejoin="round" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
                  <path d="M8 9h8M9.5 12h5M11 15h2" className="stroke-ink" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <div>
                  <h2 id="lead-filters-title" className="text-[32px] font-extrabold">{P.title}</h2>
                  <p className="m-0 mt-1.5 text-base text-[#4a5361]">{P.intro}</p>
                </div>
              </div>
              <button type="button" aria-label={P.close} onClick={onClose} className="k-close inline-flex size-12 shrink-0 items-center justify-center rounded-full text-ink">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            {open && children}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e3e6ec] px-5 py-4 md:px-10">
              <button type="button" onClick={onClear} className="k-btn k-link min-h-[52px] rounded-[12px] px-4 font-semibold underline">
                {P.clear}
              </button>
              <button type="button" onClick={onClose} className="k-lift flex text-lg font-semibold text-white">
                <span className="hx inline-flex min-h-14 items-center gap-2.5 bg-ink pl-[34px] pr-[30px] [--c:14px]">
                  {n === 1 ? P.showOne : fill(P.show, { n: n.toLocaleString(t.intl) })}
                  <Chevron className="k-arrow text-honey" />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
