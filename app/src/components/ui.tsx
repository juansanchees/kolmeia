import type { ComponentProps } from "react";

const base = "w-full border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink/50";

export function Field({ label, htmlFor, hint, error, children }: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-mono text-xs uppercase tracking-wide">
        {label}
      </label>
      {children}
      {hint && <p id={`${htmlFor}-hint`} className="text-sm text-ink/70">{hint}</p>}
      {error && <p id={`${htmlFor}-error`} role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function TextInput(props: ComponentProps<"input">) {
  return <input {...props} className={`${base} ${props.className ?? ""}`} />;
}

export function TextArea(props: ComponentProps<"textarea">) {
  return <textarea rows={4} {...props} className={`${base} ${props.className ?? ""}`} />;
}

export function Button({ className = "", ...props }: ComponentProps<"button">) {
  return (
    <button
      {...props}
      className={`border border-blue bg-blue px-5 py-2.5 font-display text-lg uppercase tracking-wide text-white hover:bg-ink hover:border-ink disabled:opacity-60 ${className}`}
    />
  );
}

export function LinkButton({ className = "", ...props }: ComponentProps<"button">) {
  return <button {...props} className={`text-sm text-blue underline underline-offset-4 ${className}`} />;
}
