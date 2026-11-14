import type { ComponentProps } from "react";

// Small presentational pieces of the E-mail area (server- and client-safe). Square corners, thin lines, blue
// for actions; the light theme only (same tokens as the rest of the app).

export function Card({ className = "", ...props }: ComponentProps<"section">) {
  return <section {...props} className={`flex min-w-0 flex-col gap-4 border border-line bg-surface p-5 ${className}`} />;
}

export function CardTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-2xl">
      {children}
    </h2>
  );
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-xs text-muted">{children}</div>;
}

export type Tone = "ink" | "blue" | "soft" | "ok" | "warn" | "cold" | "danger";

export function Badge({ tone = "cold", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  const cls: Record<Tone, string> = {
    ink: "bg-ink text-white",
    blue: "bg-blue text-white",
    soft: "bg-blue-soft text-blue-ink",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    cold: "bg-cold text-cold-ink",
    danger: "bg-warn-soft text-danger",
  };
  return (
    <span title={title} className={`inline-block whitespace-nowrap px-2 py-0.5 font-mono text-xs ${cls[tone]}`}>
      {children}
    </span>
  );
}

export function Notice({ tone = "warn", children, role = "status" }: { tone?: "warn" | "info" | "ok"; children: React.ReactNode; role?: "status" | "alert" }) {
  const cls = tone === "warn" ? "bg-warn-soft text-warn" : tone === "ok" ? "bg-ok-soft text-ok" : "bg-blue-wash text-blue-ink";
  return (
    <p role={role} className={`px-3 py-2.5 text-sm ${cls}`}>
      {children}
    </p>
  );
}

export const btn = {
  primary:
    "inline-flex min-h-12 items-center justify-center border border-blue bg-blue px-5 text-[15px] font-semibold text-white hover:border-ink hover:bg-ink disabled:cursor-not-allowed disabled:opacity-60",
  ghost:
    "inline-flex min-h-11 items-center justify-center border border-edge bg-surface px-4 text-[15px] font-medium text-ink hover:border-ink disabled:cursor-not-allowed disabled:opacity-60",
  danger:
    "inline-flex min-h-11 items-center justify-center border border-danger bg-surface px-4 text-[15px] font-medium text-danger hover:bg-warn-soft disabled:cursor-not-allowed disabled:opacity-60",
  link: "text-sm text-blue underline underline-offset-4 disabled:opacity-60",
  /** The one orange button of the product: "Passar pra closer". */
  cta: "inline-flex min-h-12 items-center justify-center border border-cta-edge bg-cta px-5 text-[15px] font-semibold text-cta-ink hover:bg-cta-edge hover:text-white disabled:cursor-not-allowed disabled:opacity-60",
};

/** Panel with a title bar (prototype: thin line under the title, mono hint on the right). */
export function Panel({ title, hint, children, className = "", id }: { title: string; hint?: string; children: React.ReactNode; className?: string; id: string }) {
  return (
    <section aria-labelledby={id} className={`flex min-w-0 flex-col border border-line bg-surface ${className}`}>
      <div className="flex items-baseline justify-between gap-2 border-b border-ink px-4 py-3.5">
        <h2 id={id} className="text-xl">
          {title}
        </h2>
        {hint && <span className="font-mono text-xs text-muted">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export const input = "w-full min-w-0 border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink/50";

/** Next step box: one obvious action per screen. */
export function NextStep({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border border-ink bg-surface p-5 shadow-[inset_4px_0_0_var(--color-blue)]">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
