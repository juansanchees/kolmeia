"use client";

import { useEffect, useRef } from "react";
import { CAL } from "./HomeTabs";

/** A big white hexagon card: the line is an outer .hx layer, the shadow sits on the unclipped wrapper. */
export function HexCard({ c = 20, className = "", innerClassName = "", style, children, ...rest }: { c?: number; className?: string; innerClassName?: string; style?: React.CSSProperties; children: React.ReactNode } & Omit<React.ComponentProps<"section">, "className" | "style">) {
  return (
    <div className={`drop-shadow-[0_14px_18px_rgba(15,27,61,0.08)] ${className}`} style={style}>
      <div className="hx bg-[#e3e6ec] p-[1.5px] [--c:12px] md:[--c:var(--hc)]" style={{ "--hc": `${c}px` } as React.CSSProperties}>
        <section {...rest} className={`hx bg-surface [--c:11.4px] md:[--c:var(--hci)] ${innerClassName}`} style={{ "--hci": `${c - 0.6}px` } as React.CSSProperties}>
          {children}
        </section>
      </div>
    </div>
  );
}

export const ICON = {
  call: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z",
  email: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6",
  look: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35",
  meeting: CAL,
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12",
  plus: "M12 5v14M5 12h14",
  check: "M5 12l5 5L20 7",
  close: "M6 6l12 12M18 6L6 18",
  left: "M15 6l-6 6 6 6",
  right: "M9 6l6 6-6 6",
} as const;

export function Icon({ d, size = 18, w = 2, className = "" }: { d: string; size?: number; w?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 ${className}`}>
      <path d={d} />
    </svg>
  );
}

/** A pill toggle (aria-pressed): honey light when on. */
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`k-btn min-h-[46px] rounded-full border-2 px-[18px] text-base text-ink ${on ? "border-honey bg-honey-light font-semibold" : "border-line bg-surface"}`}>
      {children}
    </button>
  );
}

/** − n + with a live count. */
export function Stepper({ value, min, max, onChange, less, more }: { value: number; min: number; max: number; onChange: (n: number) => void; less: string; more: string }) {
  const b = "k-btn inline-flex size-11 items-center justify-center rounded-[11px] bg-surface text-[22px] text-ink disabled:opacity-40";
  return (
    <div className="inline-flex items-center gap-1 self-start rounded-[14px] bg-[#eef0f4] p-1">
      <button type="button" aria-label={less} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className={b}>−</button>
      <span aria-live="polite" className="min-w-16 text-center font-display text-[26px] font-extrabold">{value}</span>
      <button type="button" aria-label={more} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className={b}>+</button>
    </div>
  );
}

/**
 * A native modal <dialog> from the right (like "Mais filtros"): Esc and X close it, the browser moves focus in and back
 * to the opener, the page behind does not scroll (globals: dialog.k-panel[open]). Full screen on a phone.
 */
export function SidePanel({ open, onClose, labelledBy, width = 860, children }: { open: boolean; onClose: () => void; labelledBy: string; width?: number; children: React.ReactNode }) {
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
      aria-labelledby={labelledBy}
      onClose={onClose}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      className="k-panel fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 text-[17px] text-ink md:left-auto md:w-[min(var(--pw),100vw)] md:py-3 md:pr-3"
      style={{ "--pw": `${width}px` } as React.CSSProperties}
    >
      <div className="h-full md:drop-shadow-[0_16px_28px_rgba(15,27,61,0.25)]">
        <div className="h-full bg-line md:hx md:p-[1.5px] md:[--c:26px]">
          <div className="flex h-full flex-col bg-surface md:hx md:[--c:25.4px]">{open && children}</div>
        </div>
      </div>
    </dialog>
  );
}

/** The dialog's title row: honey hexagon, title, one plain line, round X. */
export function PanelHead({ id, title, intro, close, onClose }: { id: string; title: string; intro: string; close: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#e3e6ec] py-5 pl-5 pr-4 md:pl-10 md:pr-9 md:pt-6">
      <div className="flex items-start gap-3.5">
        <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden className="mt-0.5 shrink-0">
          <path className="fill-honey stroke-honey" strokeWidth="1.6" strokeLinejoin="round" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
          <path d="M8 9h8M8 12h8M8 15h5" className="stroke-ink" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <div>
          <h2 id={id} className="text-[32px] font-extrabold">{title}</h2>
          <p className="m-0 mt-1.5 text-base text-[#4a5361]">{intro}</p>
        </div>
      </div>
      <button type="button" aria-label={close} onClick={onClose} className="k-close inline-flex size-12 shrink-0 items-center justify-center rounded-full text-ink">
        <Icon d={ICON.close} size={22} w={2.2} />
      </button>
    </div>
  );
}

/** The honey hexagon call to action (navy text on honey), or navy when `dark`. */
export function HexCta({ children, dark = false, className = "" }: { children: React.ReactNode; dark?: boolean; className?: string }) {
  return (
    <span className={`hx inline-flex min-h-14 items-center justify-center gap-2.5 px-8 font-semibold [--c:14px] ${dark ? "bg-ink text-white" : "bg-honey text-ink"} ${className}`}>
      {children}
    </span>
  );
}
