// Kolmeia mark ("Favo"). Source of truth: brand/logo-mark.svg. Decorative: put the name next to it.
// Below 28 px use the wider-gap geometry in brand/logo-mark-small.svg instead.
export function KolmeiaMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" strokeWidth="1.2" strokeLinejoin="round" className="shrink-0">
      <path fill="currentColor" stroke="currentColor" d="M5.938 1.309 10.65 4.03v5.44l-4.712 2.721L1.226 9.47V4.03Z" />
      <path fill="currentColor" stroke="currentColor" d="M18.062 1.309 22.774 4.03v5.44l-4.712 2.721L13.35 9.47V4.03Z" />
      <path fill="#F5A400" stroke="#F5A400" d="M12 11.809 16.712 14.53v5.44L12 22.691 7.288 19.97v-5.44Z" />
    </svg>
  );
}
