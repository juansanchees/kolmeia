import type { ComponentProps } from "react";
import { buttonClass, HexPanel, Notice as UiNotice } from "@/components/ui";

// Small presentational pieces of the E-mail area (server- and client-safe), imported all over the app. They sit on top
// of the shared look in components/ui (navy ink + honey, rounded small pieces); every export and prop is kept stable.

export function Card({ className = "", ...props }: ComponentProps<"section">) {
  return <section {...props} className={`flex min-w-0 flex-col gap-4 rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] ${className}`} />;
}

export function CardTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-2xl">
      {children}
    </h2>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[13px] font-medium uppercase tracking-wide text-[#4a5361]">{children}</div>;
}

export type Tone = "ink" | "blue" | "soft" | "ok" | "warn" | "cold" | "danger";

const badgeCls: Record<Tone, string> = {
  ink: "bg-ink text-white",
  // "blue" was the old accent (active, interested): now the honey pill
  blue: "bg-honey-pill text-ink",
  soft: "bg-honey-soft text-[#7a4e00]",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  cold: "bg-cold text-cold-ink",
  danger: "bg-[#fde8e7] text-danger",
};

export function Badge({ tone = "cold", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${badgeCls[tone]}`}>
      {children}
    </span>
  );
}

/** Message band; same as the shared ui Notice, with "warn" as the default tone (as it always was here). */
export function Notice({ tone = "warn", children, role = "status" }: { tone?: "warn" | "info" | "ok"; children: React.ReactNode; role?: "status" | "alert" }) {
  return (
    <UiNotice tone={tone} role={role}>
      {children}
    </UiNotice>
  );
}

const dis = "disabled:cursor-not-allowed disabled:opacity-60";

export const btn = {
  primary: buttonClass("primary"),
  ghost: buttonClass("secondary", "sm"),
  danger: `k-btn inline-flex min-h-11 items-center justify-center gap-2 rounded-[12px] border-2 border-danger bg-surface px-4 text-[15px] font-semibold text-danger hover:bg-[#fde8e7] ${dis}`,
  link: `k-link rounded-[8px] text-[15px] font-medium underline ${dis}`,
  /** The one warm button of the product: "Passar pra closer" (ink text on honey, never white). */
  cta: `k-btn inline-flex min-h-12 items-center justify-center gap-2 rounded-[12px] border-2 border-honey bg-honey px-5 text-[15px] font-semibold text-ink hover:border-[#d98f00] hover:bg-honey-glow ${dis}`,
};

/** Panel with a title bar (title on the left, a short mono hint in a pill on the right). */
export function Panel({ title, hint, children, className = "", id }: { title: string; hint?: string; children: React.ReactNode; className?: string; id: string }) {
  return (
    <section aria-labelledby={id} className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[#e3e6ec] bg-surface shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e3e6ec] px-4 py-3.5">
        <h2 id={id} className="text-xl">
          {title}
        </h2>
        {hint && <span className="rounded-full bg-honey-pill px-2.5 py-0.5 font-mono text-[13px] text-ink">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export const input = "k-input w-full min-w-0 rounded-[12px] border-2 border-line bg-surface px-3.5 py-2.5 text-base text-ink placeholder:text-muted disabled:bg-cold disabled:opacity-70";

/** Next step box: one obvious action per screen (a honey hexagon band). */
export function NextStep({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <HexPanel tone="honey" c={20} cSm={10} wrapClassName="k-in" className="flex flex-col gap-3 py-5">
      <Label>{label}</Label>
      {children}
    </HexPanel>
  );
}
