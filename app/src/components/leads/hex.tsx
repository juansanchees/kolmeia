/** The honey hexagon of the logo, optionally with a step number (navy on honey, never white). */
/** `turn`: the hexagon (never the number) rotates when its .k-step is hovered. */
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

export function Chevron({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
