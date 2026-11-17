// Shared primitives of the Kolmeia visual system (navy ink + honey, side-pointed hexagons for big blocks, rounded
// small pieces). No hooks here, so server and client components can both import it.
import Link from "next/link";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { KolmeiaMark } from "./Logo";

/* ---------------------------------------------------------------- icons */

/** The honey hexagon of the logo, optionally with a step number (navy on honey, never white).
 *  `turn`: the hexagon (never the number) rotates when its `.k-step` ancestor is hovered. */
export function HexIcon({ n, size = 32, className = "", turn = false }: { n?: number; size?: number; className?: string; turn?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={`shrink-0 ${className}`}>
      <path className={`fill-honey stroke-honey ${turn ? "k-hex" : ""}`} strokeWidth="1.6" strokeLinejoin="round" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
      {n !== undefined && (
        <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" className="fill-ink">
          {n}
        </text>
      )}
    </svg>
  );
}

/** Right-pointing chevron; add `className="k-arrow"` to nudge it when its `.k-btn`/`.k-lift` parent is hovered. */
export function Chevron({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** A 24x24 stroke icon from one SVG path `d` (e.g. the paths in LeadsNav). Decorative. */
export function Icon({ d, size = 22, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 ${className}`}>
      <path d={d} />
    </svg>
  );
}

/* ---------------------------------------------------------------- form fields */

const inputCls = "k-input w-full min-h-12 rounded-[12px] border-2 border-line bg-surface px-3.5 py-2.5 text-base text-ink placeholder:text-muted disabled:bg-cold disabled:opacity-70";

/** Label + control + optional hint/error. The hint id is `${htmlFor}-hint`, the error id `${htmlFor}-error`. */
export function Field({ label, htmlFor, hint, error, children }: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="font-mono text-[13px] font-medium uppercase tracking-wide text-ink">
        {label}
      </label>
      {children}
      {hint && <p id={`${htmlFor}-hint`} className="text-sm text-muted">{hint}</p>}
      {error && <p id={`${htmlFor}-error`} role="alert" className="text-sm font-medium text-danger">{error}</p>}
    </div>
  );
}

export function TextInput(props: ComponentProps<"input">) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function TextArea(props: ComponentProps<"textarea">) {
  return <textarea rows={4} {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

/** Native select with the same look as TextInput. */
export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={`${inputCls} pr-9 ${props.className ?? ""}`} />;
}

/* ---------------------------------------------------------------- buttons */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variantCls: Record<ButtonVariant, string> = {
  primary: "k-btn border-2 border-ink bg-ink text-white hover:border-[#1d2d5c] hover:bg-[#1d2d5c]",
  secondary: "k-btn border-2 border-line bg-surface text-ink hover:border-ink",
  ghost: "k-link border-2 border-transparent bg-transparent text-ink underline-offset-4 decoration-2 decoration-honey hover:underline",
  danger: "k-btn border-2 border-danger bg-danger text-white hover:border-[#8c1d17] hover:bg-[#8c1d17]",
};

/** Class string of a button, for a `<Link>` or `<a>` that must look like one: `<Link className={buttonClass("secondary")}>`. */
export function buttonClass(variant: ButtonVariant = "primary", size: "md" | "sm" = "md") {
  const box = size === "sm" ? "min-h-11 px-4 text-[15px]" : "min-h-12 px-6 text-base";
  return `inline-flex items-center justify-center gap-2 rounded-[12px] font-semibold no-underline disabled:cursor-not-allowed disabled:opacity-60 ${box} ${variantCls[variant]}`;
}

/** Rounded button. Default = primary navy; `variant`: "secondary" outline, "ghost" text with honey underline, "danger" red. */
export function Button({ className = "", variant = "primary", size = "md", ...props }: ComponentProps<"button"> & { variant?: ButtonVariant; size?: "md" | "sm" }) {
  return <button {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

/** Inline text button (honey underline), e.g. "Já tem conta? Entrar". */
export function LinkButton({ className = "", ...props }: ComponentProps<"button">) {
  return <button {...props} className={`k-link min-h-11 rounded-[10px] px-1 text-base font-medium underline ${className}`} />;
}

type HexTone = "navy" | "honey";
const hexBtnFill: Record<HexTone, string> = { navy: "bg-ink text-white", honey: "bg-honey text-ink" };

function hexInner(tone: HexTone, children: ReactNode) {
  return (
    <span className={`hx inline-flex min-h-[54px] w-full items-center justify-center gap-2.5 px-[30px] text-[17px] font-semibold [--c:14px] ${hexBtnFill[tone]}`}>
      {children}
    </span>
  );
}

const hexOuter = "k-lift inline-flex no-underline drop-shadow-[0_8px_12px_rgba(15,27,61,0.22)] disabled:pointer-events-none disabled:opacity-60";

/** Primary hexagon CTA (one per screen). `tone`: "navy" (default) or "honey" (ink text). Add `<Chevron className="k-arrow" />` for a nudge. */
export function HexButton({ tone = "navy", className = "", children, ...props }: ComponentProps<"button"> & { tone?: HexTone }) {
  return (
    <button {...props} className={`${hexOuter} ${className}`}>
      {hexInner(tone, children)}
    </button>
  );
}

/** Same as HexButton for navigation (next/link). */
export function HexLink({ tone = "navy", className = "", children, ...props }: ComponentProps<typeof Link> & { tone?: HexTone }) {
  return (
    <Link {...props} className={`${hexOuter} ${className}`}>
      {hexInner(tone, children)}
    </Link>
  );
}

/* ---------------------------------------------------------------- blocks */

type PanelTone = "white" | "honey" | "navy";
const panelTone: Record<PanelTone, { edge: string; fill: string }> = {
  white: { edge: "bg-[#e3e6ec] p-[1.5px]", fill: "bg-surface text-ink" },
  honey: { edge: "bg-honey-edge p-[2px]", fill: "bg-honey-soft text-ink" },
  navy: { edge: "bg-ink p-0", fill: "bg-ink text-white" },
};

/** Big block as a side-pointed hexagon: border layer + fill, shadow on an unclipped wrapper, side padding that clears
 *  the diagonal. `c` = point depth in px from md up (default 22), `cSm` on phones (default 12). `tone`: white/honey/navy.
 *  `className` styles the inner fill (vertical padding defaults to py-6; px-* overrides the safe side padding),
 *  `wrapClassName` the outer wrapper (margins, grid placement, k-in). Never put dropdowns/popovers inside it. */
export function HexPanel({ c = 22, cSm = 12, tone = "white", raised = false, as: Tag = "div", className = "py-6", wrapClassName = "", style, children, ...rest }: Omit<ComponentProps<"div">, "ref"> & {
  c?: number;
  cSm?: number;
  tone?: PanelTone;
  /** bigger, darker shadow (hero blocks, the selected card) */
  raised?: boolean;
  as?: "div" | "section" | "article" | "aside";
  wrapClassName?: string;
}) {
  const vars = { "--hc": `${c}px`, "--hc-sm": `${cSm}px` } as CSSProperties;
  const t = panelTone[tone];
  return (
    <div className={`${raised ? "drop-shadow-[0_18px_22px_rgba(15,27,61,0.28)]" : "drop-shadow-[0_6px_12px_rgba(15,27,61,0.07)]"} ${wrapClassName}`} style={vars}>
      <div className={`hx hx-out ${t.edge}`}>
        <Tag {...rest} style={style} className={`hx hx-in ${t.fill} ${className}`}>
          {children}
        </Tag>
      </div>
    </div>
  );
}

/** Logged-out page (login, onboarding, invite): the Kolmeia logo over a centered white HexPanel on the ground
 *  color. `aside` sits at the top right (e.g. <LocaleSwitch />); `logo={false}` hides the logo (pages for e-mail
 *  recipients, who don't know Kolmeia). */
export function PublicShell({ children, aside, logo = true, lang }: { children: ReactNode; aside?: ReactNode; logo?: boolean; lang?: string }) {
  return (
    <main lang={lang} className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center gap-6 px-4 py-10">
      {(logo || aside) && (
        <div className="k-in flex flex-wrap items-center justify-between gap-3">
          {logo ? (
            <p className="m-0 flex items-center gap-2.5 font-display text-3xl font-bold uppercase tracking-wide">
              <KolmeiaMark size={40} />
              Kolmeia
            </p>
          ) : <span />}
          {aside}
        </div>
      )}
      <HexPanel c={24} cSm={14} raised={false} wrapClassName="k-in [animation-delay:.06s]" className="flex flex-col gap-5 py-8 md:py-10">
        {children}
      </HexPanel>
    </main>
  );
}

/** Small/medium rounded card (radius 16, soft shadow). For lists of items inside a page; big blocks use HexPanel. */
export function Card({ className = "", ...props }: ComponentProps<"div">) {
  return <div {...props} className={`rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] ${className}`} />;
}

/** Page title (Archivo, uppercase) + one plain-language subtitle line + optional actions on the right. */
export function PageHeader({ title, subtitle, actions, className = "" }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={`k-in flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-4xl md:text-[46px]">{title}</h1>
        {subtitle && <p className="m-0 text-lg text-[#4a5361]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

/** Numbered step heading (honey hexagon with the number + title), like the Leads filter steps. The hexagon turns on
 *  hover of the nearest `.k-step` (the heading itself, or put `k-step` on the step's wrapper). */
export function StepTitle({ n, children, hint, as: Tag = "h2" }: { n: number; children: ReactNode; hint?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <div className="k-step flex flex-col gap-1">
      <Tag className="flex items-center gap-2.5 font-body text-lg font-semibold normal-case tracking-normal">
        <HexIcon n={n} turn />
        {children}
      </Tag>
      {hint && <p className="m-0 pl-[42px] text-base text-[#4a5361]">{hint}</p>}
    </div>
  );
}

const INBOX = "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z";

/** Nothing to show yet: icon (an SVG path `d`, default inbox) in a honey hexagon, a title, what to do next, and an optional action (e.g. a HexLink). */
export function EmptyState({ icon, title, children, action, className = "" }: { icon?: string; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`k-fade flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-10 text-center ${className}`}>
      <span className="hxv inline-flex h-[62px] w-14 items-center justify-center bg-honey-light text-ink">
        <Icon d={icon ?? INBOX} size={26} />
      </span>
      <p className="m-0 text-lg font-semibold">{title}</p>
      {children && <div className="max-w-prose text-base text-[#4a5361]">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- tabs, pills, notices */

/** Segmented tab bar look, shared by SubNav (links) and SegmentedTabs (buttons). */
export const segWrapCls = "inline-flex max-w-full flex-wrap gap-[5px] rounded-2xl bg-[#e9ecf1] p-[5px]";
export const segItemCls = (on: boolean) =>
  `k-btn inline-flex min-h-12 items-center gap-2 rounded-[12px] px-[18px] text-base no-underline md:px-[22px] ${on ? "bg-ink font-semibold text-white" : "font-medium text-ink hover:bg-surface"}`;

/** In-page tabs (state, not routes): buttons with aria-pressed. For route tabs use SubNav. Wrap the switched content
 *  in an element with `key={value}` and `className="k-fade"` for the fade. */
export function SegmentedTabs<V extends string>({ label, items, value, onChange, className = "" }: {
  label: string;
  items: readonly { value: V; label: ReactNode; icon?: string; count?: number }[];
  value: V;
  onChange: (v: V) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`${segWrapCls} ${className}`}>
      {items.map((i) => {
        const on = i.value === value;
        return (
          <button key={i.value} type="button" aria-pressed={on} onClick={() => onChange(i.value)} className={segItemCls(on)}>
            {i.icon && <Icon d={i.icon} size={18} />}
            {i.label}
            {i.count !== undefined && <CountPill tone={on ? "honey" : "cold"}>{i.count}</CountPill>}
          </button>
        );
      })}
    </div>
  );
}

const pillTone = {
  honey: "bg-honey text-ink",
  soft: "bg-honey-pill text-ink",
  cold: "bg-cold text-[#4a5361]",
  navy: "bg-ink text-white",
} as const;

/** A count in a mono pill: `<CountPill>12</CountPill>`. `tone`: honey (selected), soft (default), cold, navy. */
export function CountPill({ tone = "soft", className = "", children, ...rest }: ComponentProps<"span"> & { tone?: keyof typeof pillTone }) {
  return (
    <span {...rest} className={`inline-flex min-w-7 items-center justify-center rounded-full px-2 py-px font-mono text-sm font-normal ${pillTone[tone]} ${className}`}>
      {children}
    </span>
  );
}

const badgeTone = {
  neutral: "bg-cold text-cold-ink",
  honey: "bg-honey-pill text-ink",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-[#fde8e7] text-danger",
  navy: "bg-ink text-white",
} as const;
export type BadgeTone = keyof typeof badgeTone;

/** Status label pill (e.g. "Ativa", "Pausada"). `dot` adds a small honey dot before the text. */
export function Badge({ tone = "neutral", dot = false, className = "", children, ...rest }: ComponentProps<"span"> & { tone?: BadgeTone; dot?: boolean }) {
  return (
    <span {...rest} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[15px] font-medium ${badgeTone[tone]} ${className}`}>
      {dot && <span aria-hidden className="size-2 rounded-full bg-honey" />}
      {children}
    </span>
  );
}

const noticeTone = {
  info: "border-honey-edge bg-honey-soft text-ink",
  ok: "border-[#9fd3bc] bg-ok-soft text-ok",
  warn: "border-[#f0c48f] bg-warn-soft text-warn",
  danger: "border-[#f1b0ab] bg-[#fde8e7] text-danger",
} as const;
export type NoticeTone = keyof typeof noticeTone;

/** A message band. `tone`: info (honey), ok, warn, danger. Same props as email/bits Notice (+ "danger"); `role` is
 *  "status" by default, pass "alert" for errors the user must notice now. */
export function Notice({ tone = "info", role = "status", className = "", children }: { tone?: NoticeTone; role?: "status" | "alert"; className?: string; children: ReactNode }) {
  return (
    <div role={role} className={`rounded-[14px] border-2 px-4 py-3 text-base ${noticeTone[tone]} ${className}`}>
      {children}
    </div>
  );
}
