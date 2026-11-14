import type { ComponentProps } from "react";

// Small buttons shared by the research screens (real <button>s, 44px targets, visible focus from globals.css).

export function Choice({ pressed, className = "", ...props }: ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      className={`min-h-11 border px-3.5 font-body text-sm ${pressed ? "border-blue bg-blue font-semibold text-white" : "border-edge bg-surface text-ink hover:border-ink"} disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
    />
  );
}

export function DarkChoice({ pressed, className = "", ...props }: ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      {...props}
      className={`min-h-11 border px-3.5 font-body text-sm ${pressed ? "border-ink bg-ink font-semibold text-white" : "border-edge bg-surface text-ink hover:border-ink"} disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
    />
  );
}

export function PrimaryButton({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-12 items-center border border-blue bg-blue px-5 text-[15px] font-semibold text-white hover:border-ink hover:bg-ink disabled:opacity-60 ${className}`}
    />
  );
}

export function GhostButton({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-11 items-center border border-edge bg-surface px-4 text-[15px] font-medium text-ink hover:border-ink disabled:opacity-60 ${className}`}
    />
  );
}

export function Pill({ tone, children }: { tone: "very_hot" | "hot" | "warm" | "cold" | "ok" | "no" | "unknown" | "high" | "medium" | "low"; children: React.ReactNode }) {
  const cls = {
    very_hot: "bg-ink text-white",
    hot: "bg-blue text-white",
    warm: "bg-blue-soft text-blue-ink",
    cold: "bg-cold text-cold-ink",
    ok: "bg-ok-soft text-ok",
    no: "bg-warn-soft text-warn",
    unknown: "bg-cold text-cold-ink",
    high: "bg-ok-soft text-ok",
    medium: "bg-blue-soft text-blue-ink",
    low: "bg-warn-soft text-warn",
  }[tone];
  return <span className={`inline-block whitespace-nowrap px-2 py-0.5 font-mono text-xs ${cls}`}>{children}</span>;
}
