import type { ComponentProps, ReactNode } from "react";
import { buttonClass, HexIcon } from "@/components/ui";

// Small pieces shared by the research and agent screens (real <button>s, 44px targets, visible focus from
// globals.css). Rounded pieces in the Kolmeia look: honey for a picked chip, navy for a picked option.

const CHECK = "M5 12l5 5L20 7";

/** A toggle chip (honey when picked, with a check that pops in). */
export function Choice({ pressed, className = "", children, ...props }: ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      className={`k-btn inline-flex min-h-11 items-center gap-2 rounded-full border-2 font-body text-[15px] text-ink disabled:cursor-not-allowed disabled:opacity-60 ${pressed ? "border-honey bg-honey-light pl-2.5 pr-4 font-semibold" : "border-line bg-surface px-4 hover:border-ink"} ${className}`}
    >
      {pressed && (
        <span aria-hidden className="k-pop inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-white">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={CHECK} />
          </svg>
        </span>
      )}
      {children}
    </button>
  );
}

/** One-of-many option (navy when picked). */
export function DarkChoice({ pressed, className = "", ...props }: ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      className={`k-btn inline-flex min-h-11 items-center rounded-[12px] border-2 px-4 font-body text-[15px] disabled:cursor-not-allowed disabled:opacity-60 ${pressed ? "border-ink bg-ink font-semibold text-white" : "border-line bg-surface text-ink hover:border-ink"} ${className}`}
    />
  );
}

export function PrimaryButton({ className = "", ...props }: ComponentProps<"button">) {
  return <button {...props} className={`${buttonClass("primary")} ${className}`} />;
}

export function GhostButton({ className = "", ...props }: ComponentProps<"button">) {
  return <button type="button" {...props} className={`${buttonClass("secondary", "sm")} ${className}`} />;
}

/** Ligar (navy, filled) / Pausar (outline): an agent's on/off button. Text only, 48px tall. */
export const powerClass = (running: boolean) => `${buttonClass(running ? "secondary" : "primary")} min-w-[8.5rem]`;

export function Pill({ tone, children }: { tone: "very_hot" | "hot" | "warm" | "cold" | "ok" | "no" | "unknown" | "high" | "medium" | "low"; children: React.ReactNode }) {
  const cls = {
    very_hot: "bg-ink text-white",
    hot: "bg-honey text-ink",
    warm: "bg-honey-pill text-ink",
    cold: "bg-cold text-cold-ink",
    ok: "bg-ok-soft text-ok",
    no: "bg-warn-soft text-warn",
    unknown: "bg-cold text-cold-ink",
    high: "bg-ok-soft text-ok",
    medium: "bg-honey-pill text-ink",
    low: "bg-warn-soft text-warn",
  }[tone];
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${cls}`}>{children}</span>;
}

/** A numbered question/step of a form: honey hexagon with the number + the question as the fieldset legend. */
export function StepSet({ n, title, hint, error, disabled, className = "", children }: { n: number; title: ReactNode; hint?: ReactNode; error?: string; disabled?: boolean; className?: string; children: ReactNode }) {
  return (
    <fieldset disabled={disabled} className={`k-step m-0 flex min-w-0 flex-col gap-3 border-0 p-0 ${className}`}>
      <legend className="mb-1 flex items-center gap-2.5 p-0 text-lg font-semibold">
        <HexIcon n={n} turn />
        {title}
      </legend>
      {hint && <p className="m-0 -mt-2 pl-[42px] text-base text-[#4a5361]">{hint}</p>}
      <div className="flex min-w-0 flex-col gap-3 md:pl-[42px]">{children}</div>
      {error && (
        <p role="alert" className="m-0 text-base font-medium text-danger md:pl-[42px]">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** One label/value line of a details list (inside a <dl>). */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 border-t border-[#e3e6ec] py-2.5 first:border-t-0 sm:grid-cols-[14rem_1fr]">
      <dt className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{label}</dt>
      <dd className="m-0 text-base">{children}</dd>
    </div>
  );
}

/** A number tile: mono label, big number, optional plain note. */
export function Stat({ label, value, note, className = "" }: { label: string; value: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-2xl border border-[#e3e6ec] bg-surface p-4 ${className}`}>
      <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{label}</span>
      <span className="font-display text-4xl font-bold leading-none">{value}</span>
      {note && <span className="text-[15px] text-[#4a5361]">{note}</span>}
    </div>
  );
}

/** Honey progress bar (decorative: the text next to it says the numbers). */
export function Meter({ value, max, className = "" }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <span aria-hidden className={`block h-2.5 w-full overflow-hidden rounded-full bg-[#e9ecf1] ${className}`}>
      <span className="block h-full rounded-full bg-honey transition-[width] duration-500" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Chat bubble of the person (navy, right). */
export function UserBubble({ children }: { children: ReactNode }) {
  return <div className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-ink px-4 py-3 text-base leading-normal text-white">{children}</div>;
}

/** Chat bubble of the AI (honey soft, left), with an optional small label. */
export function AiBubble({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="flex max-w-full flex-col gap-3.5 self-start rounded-2xl rounded-bl-md border-2 border-honey-edge bg-honey-soft p-4 sm:max-w-[92%]">
      {label && <span className="font-mono text-[12px] uppercase tracking-wide text-ink">{label}</span>}
      {children}
    </div>
  );
}
